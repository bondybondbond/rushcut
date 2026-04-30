mod db;

use base64::Engine as _;
use db::{
    add_clip_cut, delete_clip, delete_project, get_job, get_project_output_paths,
    get_project_with_clips, insert_clip, insert_job, insert_project, list_projects,
    rename_project, reorder_clips, update_clip_proxy, update_clip_review, update_clip_thumbnail,
    update_clip_waveform, update_job_analysis, update_job_done, update_job_error,
    update_job_progress, Clip, ClipMeta, Job, ProjectSummary, ProjectWithClips,
};
use serde_json::json;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_DIR: &str = r"C:\clips\processed";

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/// Convert a project name to a safe filename slug.
/// e.g. "My Holiday Trip!" -> "my-holiday-trip"
fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    // Collapse consecutive hyphens and trim leading/trailing
    let slug = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() { "project".to_string() } else { slug }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Translate a Windows path to WSL2 /mnt/... path.
/// Used only by start_job (render pipeline stays on WSL). Do not use for scan/proxy.
fn win_to_wsl(path: &str) -> String {
    let p = path.replace('\\', "/");
    if p.len() >= 2 && p.chars().nth(1) == Some(':') {
        let drive = p.chars().next().unwrap().to_lowercase().to_string();
        let rest = p[2..].trim_start_matches('/');
        format!("/mnt/{}/{}", drive, rest)
    } else {
        p
    }
}

// ---------------------------------------------------------------------------
// Native FFmpeg helpers (Batch 16 — replaces WSL scan.py / proxy.py)
// ---------------------------------------------------------------------------

/// FFmpeg executable name — resolved via system PATH (installed via WinGet).
/// Falls back gracefully: if not in PATH, commands return errors logged to stderr.
fn ffmpeg_exe() -> &'static str { "ffmpeg" }
fn ffprobe_exe() -> &'static str { "ffprobe" }

/// Detect the best available H.264 encoder once and cache the result.
/// Order: h264_nvenc (Nvidia) → h264_qsv (Intel) → h264_amf (AMD) → libx264 (software).
/// Each candidate is tested with a 1-frame lavfi encode to /dev/null.
static BEST_ENCODER: OnceLock<String> = OnceLock::new();

fn detect_best_encoder() -> &'static str {
    BEST_ENCODER.get_or_init(|| {
        for enc in &["h264_nvenc", "h264_qsv", "h264_amf"] {
            let ok = std::process::Command::new(ffmpeg_exe())
                .args([
                    "-f", "lavfi", "-i", "color=black:s=128x72:r=1",
                    "-vframes", "1", "-c:v", enc, "-f", "null", "-",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                eprintln!("[proxy] GPU encoder selected: {}", enc);
                return enc.to_string();
            }
        }
        eprintln!("[proxy] no GPU encoder available, using libx264 (software)");
        "libx264".to_string()
    })
}

/// Video extensions to scan (case-insensitive check applied by caller).
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "mts", "m2ts"];

/// Probe a single video file with ffprobe. Returns ClipMeta on success.
fn probe_single_file(path: &std::path::Path) -> Result<ClipMeta, String> {
    let path_str = path.to_string_lossy().to_string();

    let size_bytes = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);

    let probe = std::process::Command::new(ffprobe_exe())
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            &path_str,
        ])
        .output()
        .map_err(|e| format!("ffprobe launch failed: {}", e))?;

    if !probe.status.success() {
        return Err(format!("ffprobe non-zero exit for {}", path_str));
    }

    let json: serde_json::Value = serde_json::from_slice(&probe.stdout)
        .map_err(|e| format!("ffprobe JSON parse error: {}", e))?;

    let empty_arr = serde_json::Value::Array(vec![]);
    let streams = json["streams"].as_array().unwrap_or(
        empty_arr.as_array().unwrap()
    );

    let video = streams.iter().find(|s| s["codec_type"].as_str() == Some("video"));
    let codec_name = video
        .and_then(|s| s["codec_name"].as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let width = video.and_then(|s| s["width"].as_i64()).unwrap_or(0);
    let height = video.and_then(|s| s["height"].as_i64()).unwrap_or(0);
    let has_audio = streams.iter().any(|s| s["codec_type"].as_str() == Some("audio"));

    // Duration: prefer stream-level, fall back to format-level
    let stream_dur = video.and_then(|s| s["duration"].as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|&d| d > 0.0);
    let format_dur = json["format"]["duration"].as_str()
        .and_then(|d| d.parse::<f64>().ok());
    let duration_s = stream_dur.or(format_dur).unwrap_or(0.0);
    let duration_ms = (duration_s * 1000.0) as i64;

    let thumbnail_data = extract_thumbnail_piped(&path_str);

    let filename = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    Ok(ClipMeta {
        filename,
        local_path: path_str,
        size_bytes,
        duration_ms,
        width,
        height,
        has_audio,
        thumbnail_data,
        codec_name,
    })
}

/// Extract a JPEG thumbnail frame at 1s seek, piped to stdout, returned as a data URI.
/// Uses -map 0:v:0 to skip DJI embedded MJPEG thumbnail in stream 1.
fn extract_thumbnail_piped(src: &str) -> Option<String> {
    let output = std::process::Command::new(ffmpeg_exe())
        .args([
            "-ss", "1",
            "-i", src,
            "-map", "0:v:0",
            "-frames:v", "1",
            "-q:v", "5",
            "-vf", "scale=320:-1",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    if output.stdout.is_empty() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&output.stdout);
    Some(format!("data:image/jpeg;base64,{}", b64))
}

/// Extract a JPEG thumbnail and write to a temp file, return data URI.
/// Used by proxy gen where -map 0:v:0 write-to-file is simpler than pipe.
fn extract_thumbnail_to_file(src: &str, clip_id: &str) -> Option<String> {
    let temp_dir = std::env::temp_dir().join("rushcut");
    let _ = std::fs::create_dir_all(&temp_dir);
    let tmp = temp_dir.join(format!("{}-thumb.jpg", clip_id));

    let status = std::process::Command::new(ffmpeg_exe())
        .args([
            "-ss", "1",
            "-i", src,
            "-map", "0:v:0",
            "-frames:v", "1",
            "-q:v", "5",
            "-y",
            tmp.to_str().unwrap_or(""),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;

    if !status.success() {
        return None;
    }
    let bytes = std::fs::read(&tmp).ok()?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.is_empty() { return None; }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/jpeg;base64,{}", b64))
}

/// Get peak volume in dBFS by running volumedetect on the audio.
/// Returns None if the clip has no audio or ffmpeg fails.
fn get_peak_volume_db(src: &str) -> Option<f64> {
    let output = std::process::Command::new(ffmpeg_exe())
        .args(["-i", src, "-filter:a", "volumedetect", "-vn", "-f", "null", "-"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if line.contains("max_volume") {
            if let Some(rest) = line.split("max_volume:").nth(1) {
                if let Ok(val) = rest.trim().split_whitespace().next().unwrap_or("").parse::<f64>() {
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Render a volume-normalised waveform PNG (800x80, green cbrt) and return as data URI.
/// Two-pass: volumedetect then showwavespic with boost so peak = 0 dBFS = full height.
fn extract_waveform_data(src: &str, clip_id: &str) -> Option<String> {
    let boost_db = get_peak_volume_db(src)
        .map(|peak| (-peak).clamp(0.0, 40.0))
        .unwrap_or(0.0);

    let temp_dir = std::env::temp_dir().join("rushcut");
    let _ = std::fs::create_dir_all(&temp_dir);
    let tmp = temp_dir.join(format!("{}-wave.png", clip_id));

    let filter = format!(
        "[0:a]volume={:.1}dB,showwavespic=s=800x80:colors=0x22c55e:scale=cbrt",
        boost_db
    );

    let status = std::process::Command::new(ffmpeg_exe())
        .args([
            "-i", src,
            "-filter_complex", &filter,
            "-frames:v", "1",
            "-y",
            tmp.to_str().unwrap_or(""),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;

    if !status.success() {
        return None;
    }
    let bytes = std::fs::read(&tmp).ok()?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.is_empty() { return None; }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{}", b64))
}

/// Check that an MP4 proxy is complete (moov atom present) via ffprobe.
/// A missing moov atom = FFmpeg was killed mid-write.
fn is_valid_proxy_file(path: &str) -> bool {
    std::process::Command::new(ffprobe_exe())
        .args(["-v", "quiet", "-show_format", path])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Encode a 480p H.264 proxy using the best available GPU encoder (detected once via OnceLock).
/// GPU encoders (nvenc/qsv/amf) handle their own hardware decode — no separate hwaccel flag needed.
/// Returns true on success.
fn generate_proxy_file(src: &str, dst: &str) -> bool {
    let encoder = detect_best_encoder();
    eprintln!("[proxy] encoding {} -> {} using {}", src, dst, encoder);
    let ok = std::process::Command::new(ffmpeg_exe())
        .args([
            "-i", src,
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c:v", encoder,
            "-preset", "ultrafast",
            "-crf", "28",
            "-vf", "scale=-2:480",
            "-c:a", "copy",
            "-y",
            dst,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        eprintln!("[proxy] encode OK: {}", dst);
    } else {
        eprintln!("[proxy] encode FAILED: {}", dst);
    }
    ok
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Scan a folder for video clips using native ffprobe (no WSL).
/// folder_path: Windows path (e.g. C:\clips\)
/// Returns array of ClipMeta with Windows local_path values.
#[tauri::command]
fn scan_folder(folder_path: String) -> Result<Vec<ClipMeta>, String> {
    let dir = std::path::Path::new(&folder_path);
    if !dir.is_dir() {
        return Ok(vec![]);
    }

    let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read dir: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file() && p.extension()
                .and_then(|e| e.to_str())
                .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();

    let mut results = Vec::new();
    for path in &entries {
        match probe_single_file(path) {
            Ok(meta) => results.push(meta),
            Err(e) => eprintln!("[scan] skipping {:?}: {}", path.file_name().unwrap_or_default(), e),
        }
    }
    Ok(results)
}

/// Delete a project and all associated clips and jobs.
/// Also removes rendered output MP4 files from disk (best-effort; missing files are silently ignored).
#[tauri::command]
fn delete_project_cmd(project_id: String) -> Result<(), String> {
    // Collect output file paths before deleting DB rows
    let paths = get_project_output_paths(&project_id).unwrap_or_default();
    for p in &paths {
        let _ = std::fs::remove_file(p); // best-effort: file may already be gone
    }
    delete_project(&project_id).map_err(|e| format!("Failed to delete project: {}", e))
}

/// Open a file in Windows Explorer with the file selected.
/// windows-only: explorer /select reveals file in Windows Explorer
#[tauri::command]
fn open_output_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn()
        .map_err(|e| format!("Failed to open explorer: {}", e))?;
    Ok(())
}

/// Persist clip order after a drag-to-reorder action on the Review screen.
/// clip_ids must be the full ordered list; each clip receives sort_order = its index.
#[tauri::command]
fn reorder_clips_cmd(clip_ids: Vec<String>) -> Result<(), String> {
    reorder_clips(&clip_ids).map_err(|e| format!("DB error (reorder clips): {}", e))
}

/// Rename a project.
#[tauri::command]
fn rename_project_cmd(project_id: String, name: String) -> Result<(), String> {
    rename_project(&project_id, &name)
        .map_err(|e| format!("DB error (rename project): {}", e))
}

/// Update per-clip review fields (include/skip, focal point, trim, zoom mode).
#[tauri::command]
fn update_clip_review_cmd(
    clip_id: String,
    in_ms: Option<i64>,
    out_ms: Option<i64>,
    focal_x: Option<f64>,
    focal_y: Option<f64>,
    zoom_mode: Option<String>,
    include: i64,
) -> Result<(), String> {
    update_clip_review(&clip_id, in_ms, out_ms, focal_x, focal_y, zoom_mode, include)
        .map_err(|e| format!("DB error (update clip review): {}", e))
}

/// Create a new cut row for a source clip (multi-cut model, Batch A).
/// Clones metadata from the source clip and sets the caller-supplied in_ms/out_ms.
/// Returns the new Clip row so the frontend can update its state immediately.
#[tauri::command]
fn add_clip_cut_cmd(
    project_id: String,
    source_clip_id: String,
    in_ms: Option<i64>,
    out_ms: Option<i64>,
) -> Result<Clip, String> {
    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get project): {}", e))?;

    let source = project_data.clips.iter()
        .find(|c| c.id == source_clip_id)
        .ok_or_else(|| format!("source clip {} not found", source_clip_id))?;

    // Cut row gets sort_order after all existing rows so filmstrip order is stable
    let max_order = project_data.clips.iter().map(|c| c.sort_order).max().unwrap_or(0);

    let cut = Clip {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        filename: source.filename.clone(),
        local_path: source.local_path.clone(),
        duration_ms: source.duration_ms,
        width: source.width,
        height: source.height,
        has_audio: source.has_audio,
        thumbnail_data: source.thumbnail_data.clone(),
        sort_order: max_order + 1,
        created_at: db::now(),
        in_ms,
        out_ms,
        focal_x: None,
        focal_y: None,
        zoom_mode: None,
        include: 1,
        proxy_path: source.proxy_path.clone(),
        waveform_data: source.waveform_data.clone(),
        codec_name: source.codec_name.clone(),
    };

    add_clip_cut(&cut).map_err(|e| format!("DB error (add clip cut): {}", e))?;
    Ok(cut)
}

/// Delete a single cut row by id (multi-cut model, Batch A).
/// Only removes the specific cut — never removes the source row.
#[tauri::command]
fn delete_clip_cmd(clip_id: String) -> Result<(), String> {
    delete_clip(&clip_id).map_err(|e| format!("DB error (delete clip): {}", e))
}

/// Probe individual video files (Windows paths) using native ffprobe (no WSL).
/// Returns ClipMeta for each valid video file.
#[tauri::command]
fn probe_files(paths: Vec<String>) -> Result<Vec<ClipMeta>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let mut results = Vec::new();
    for path_str in &paths {
        let path = std::path::Path::new(path_str);
        let ext_ok = path.extension()
            .and_then(|e| e.to_str())
            .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !path.is_file() || !ext_ok {
            continue;
        }
        match probe_single_file(path) {
            Ok(meta) => results.push(meta),
            Err(e) => eprintln!("[probe] skipping {:?}: {}", path.file_name().unwrap_or_default(), e),
        }
    }
    Ok(results)
}

/// Create a project and persist clips to SQLite.
/// Returns the new project_id.
#[tauri::command]
fn create_project(name: String, clips: Vec<ClipMeta>) -> Result<String, String> {
    let project_id = Uuid::new_v4().to_string();

    insert_project(&name, &project_id)
        .map_err(|e| format!("DB error (insert project): {}", e))?;

    for (idx, meta) in clips.iter().enumerate() {
        let clip = Clip {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.clone(),
            filename: meta.filename.clone(),
            local_path: meta.local_path.clone(),
            duration_ms: meta.duration_ms,
            width: meta.width,
            height: meta.height,
            has_audio: meta.has_audio,
            thumbnail_data: meta.thumbnail_data.clone(),
            sort_order: idx as i64,
            created_at: db::now(),
            // Review fields — defaults, set via update_clip_review / update_clip_proxy
            in_ms: None,
            out_ms: None,
            focal_x: None,
            focal_y: None,
            zoom_mode: None,
            include: 0, // explicit-add model: insert_clip SQL enforces 0; this matches for clarity
            proxy_path: None,
            waveform_data: None,
            codec_name: meta.codec_name.clone(),
        };
        insert_clip(&clip).map_err(|e| format!("DB error (insert clip {}): {}", meta.filename, e))?;
    }

    Ok(project_id)
}

/// Read a project and its clips from SQLite.
#[tauri::command]
fn get_project(project_id: String) -> Result<ProjectWithClips, String> {
    get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get project): {}", e))
}

/// Start a render job: writes manifest, spawns run.py via WSL, streams progress events.
/// Returns the new job_id immediately (pipeline runs in background).
#[tauri::command]
async fn start_job(
    app: AppHandle,
    project_id: String,
    settings_json: String,
) -> Result<String, String> {
    let job_id = Uuid::new_v4().to_string();

    // Get clips for this project
    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get clips): {}", e))?;

    // Build output path — slug-01.mp4, slug-02.mp4 ... (per-project counter)
    let slug = slugify(&project_data.project.name);
    let counter = std::fs::read_dir(DEFAULT_OUTPUT_DIR)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
              .filter(|e| {
                  let name = e.file_name().to_string_lossy().to_string();
                  name.starts_with(&format!("{}-", slug)) && name.ends_with(".mp4")
              })
              .count()
        })
        .unwrap_or(0);
    let output_path = format!(r"{}\{}-{:02}.mp4", DEFAULT_OUTPUT_DIR, slug, counter + 1);

    // Filter out skipped clips (include == 0) — they don't reach the pipeline.
    let included_clips: Vec<&Clip> = project_data.clips.iter()
        .filter(|c| c.include != 0)
        .collect();
    if included_clips.is_empty() {
        return Err("No clips selected for render".to_string());
    }

    // Write manifest JSON to Windows TEMP
    let manifest = json!({
        "job_id": job_id,
        "clips": included_clips.iter().map(|c| {
            // Clamp out_ms to clip duration to prevent FFmpeg crash on out-of-bounds trim
            let clamped_out = c.out_ms.map(|o| o.min(c.duration_ms));
            json!({
                "id": c.id,
                "filename": c.filename,
                "local_path": c.local_path,
                "duration_ms": c.duration_ms,
                "width": c.width,
                "height": c.height,
                "has_audio": c.has_audio,
                "in_ms": c.in_ms,
                "out_ms": clamped_out,
                "focal_x": c.focal_x,
                "focal_y": c.focal_y,
                "zoom_mode": c.zoom_mode,
            })
        }).collect::<Vec<_>>(),
        "settings": serde_json::from_str::<serde_json::Value>(&settings_json)
            .unwrap_or(json!({})),
        "output_path": output_path,
    });

    let temp_dir = std::env::temp_dir().join("rushcut");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let manifest_path = temp_dir.join(format!("{}.json", job_id));
    std::fs::write(&manifest_path, manifest.to_string())
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    let wsl_manifest = win_to_wsl(&manifest_path.to_string_lossy());

    // Insert job row
    let now = db::now();
    insert_job(&Job {
        id: job_id.clone(),
        project_id: project_id.clone(),
        status: "pending".to_string(),
        progress_pct: 0,
        local_output_path: Some(output_path.clone()),
        settings_json: Some(settings_json),
        error_message: None,
        analysis_summary: None,
        created_at: now.clone(),
        updated_at: now,
    })
    .map_err(|e| format!("DB error (insert job): {}", e))?;

    // Spawn pipeline in background — emit events as stdout lines arrive
    let job_id_bg = job_id.clone();
    tauri::async_runtime::spawn(async move {
        run_pipeline(app, job_id_bg, wsl_manifest).await;
    });

    Ok(job_id)
}

/// Read a job from SQLite.
#[tauri::command]
fn get_job_cmd(job_id: String) -> Result<Job, String> {
    get_job(&job_id).map_err(|e| format!("DB error (get job): {}", e))
}

/// List all projects with clip count and last job status (for Library page).
#[tauri::command]
fn list_projects_cmd() -> Result<Vec<ProjectSummary>, String> {
    list_projects().map_err(|e| format!("DB error (list projects): {}", e))
}

// ---------------------------------------------------------------------------
// Pipeline runner (background)
// ---------------------------------------------------------------------------

async fn run_pipeline(app: AppHandle, job_id: String, wsl_manifest_path: String) {
    let mut child = match std::process::Command::new("wsl")
        .args([
            "-d", "Ubuntu-24.04",
            "-u", "root",
            "--",
            "python3",
            "/mnt/c/apps/rushcut/pipeline/run.py",
            "--job-id", &job_id,
            "--manifest-path", &wsl_manifest_path,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to spawn pipeline: {}", e);
            eprintln!("[pipeline] {}", msg);
            let _ = update_job_error(&job_id, &msg);
            emit_error(&app, &job_id, &msg);
            return;
        }
    };

    let stdout = child.stdout.take().expect("piped stdout");
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if let Some(stage_name) = line.strip_prefix("STAGE:") {
            let _ = app.emit(
                "pipeline-stage",
                json!({ "jobId": job_id, "stage": stage_name.trim() }),
            );
        } else if let Some(data) = line.strip_prefix("ANALYSIS:") {
            // Store motion analysis summary from pipeline (Batch 13).
            // Format: clips_used=N,clips_total=M,clips_excluded=X
            let _ = update_job_analysis(&job_id, data.trim());
        } else if let Some(pct_str) = line.strip_prefix("PROGRESS:") {
            let pct: i64 = pct_str.trim().parse().unwrap_or(0);
            let _ = update_job_progress(&job_id, pct, "processing");
            let _ = app.emit(
                "pipeline-progress",
                json!({
                    "jobId": job_id,
                    "progress": pct,
                }),
            );
        } else if let Some(wsl_out) = line.strip_prefix("DONE:") {
            // Convert WSL path back to Windows path for storage
            let wsl_out = wsl_out.trim();
            let win_out = wsl_to_win(wsl_out);
            let _ = update_job_done(&job_id, &win_out);
            let _ = app.emit(
                "pipeline-done",
                json!({
                    "jobId": job_id,
                    "stage": "done",
                    "progress": 100,
                    "message": "Done",
                    "outputPath": win_out
                }),
            );
            return;
        } else if let Some(err_msg) = line.strip_prefix("ERROR:") {
            let msg = err_msg.trim().to_string();
            let _ = update_job_error(&job_id, &msg);
            emit_error(&app, &job_id, &msg);
            return;
        }
    }

    // Process exited without DONE/ERROR — check exit status
    let status = child.wait().unwrap_or_else(|_| {
        std::process::ExitStatus::default()
    });
    if !status.success() {
        let msg = format!("Pipeline exited with status: {}", status);
        let _ = update_job_error(&job_id, &msg);
        emit_error(&app, &job_id, &msg);
    }
}

// ---------------------------------------------------------------------------
// Proxy generation (background)
// ---------------------------------------------------------------------------

/// Kick off the upfront media batch (thumbnail + waveform) for all clips in a project.
/// Proxy gen is now lazy — see generate_proxy_for_clip.
/// Returns immediately; batch runs in a background task.
#[tauri::command]
async fn generate_proxies_cmd(
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<HashSet<String>>>>,
    project_id: String,
) -> Result<(), String> {
    // Concurrency guard: only one batch run per project at a time.
    {
        let mut set = state.lock().unwrap();
        if set.contains(&project_id) {
            eprintln!("[proxy] batch already running for project {}, skipping", project_id);
            return Ok(());
        }
        set.insert(project_id.clone());
    }

    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get clips): {}", e))?;

    let all_clips = project_data.clips;
    if all_clips.is_empty() {
        state.lock().unwrap().remove(&project_id);
        return Ok(());
    }

    let guard = Arc::clone(&*state);
    let pid = project_id.clone();
    tauri::async_runtime::spawn(async move {
        run_media_batch(app, pid.clone(), all_clips).await;
        guard.lock().unwrap().remove(&pid);
    });

    Ok(())
}

/// Generate a proxy for a single clip on demand.
/// Called by Trimmer.tsx when WebView2 fires onError on the source video.
/// Uses the best available GPU encoder (detected once via OnceLock).
#[tauri::command]
async fn generate_proxy_for_clip(
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<HashSet<String>>>>,
    project_id: String,
    clip_id: String,
) -> Result<(), String> {
    // Concurrency guard keyed by clip to prevent duplicate encode if onError fires twice
    let guard_key = format!("{}-{}", project_id, clip_id);
    {
        let mut set = state.lock().unwrap();
        if set.contains(&guard_key) {
            eprintln!("[proxy] already generating proxy for clip {}, skipping", clip_id);
            return Ok(());
        }
        set.insert(guard_key.clone());
    }

    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get clip): {}", e))?;
    let clip = project_data.clips.into_iter().find(|c| c.id == clip_id)
        .ok_or_else(|| format!("clip {} not found in project {}", clip_id, project_id))?;

    let guard = Arc::clone(&*state);
    tauri::async_runtime::spawn(async move {
        run_single_proxy(app, project_id, clip).await;
        guard.lock().unwrap().remove(&guard_key);
    });

    Ok(())
}

/// Upfront media batch: thumbnail + waveform for all clips.
/// Proxy generation is now lazy — triggered per-clip via generate_proxy_for_clip when
/// WebView2 cannot decode the source file (onError in Trimmer.tsx).
async fn run_media_batch(app: AppHandle, project_id: String, clips: Vec<Clip>) {
    for clip in clips.iter() {
        let clip_id = &clip.id;
        let src = &clip.local_path;

        // Step 1: Thumbnail — always refresh from source (~1s)
        if let Some(data) = extract_thumbnail_to_file(src, clip_id) {
            let _ = update_clip_thumbnail(clip_id, &data);
            let _ = app.emit("thumbnail-progress", json!({
                "projectId": project_id,
                "clipId": clip_id,
                "thumbnailData": data,
            }));
        }

        // Step 2: Waveform — skip if already stored (~3-5s)
        if clip.waveform_data.is_none() {
            if let Some(data) = extract_waveform_data(src, clip_id) {
                let _ = update_clip_waveform(clip_id, &data);
                let _ = app.emit("waveform-progress", json!({
                    "projectId": project_id,
                    "clipId": clip_id,
                    "waveformData": data,
                }));
            }
        }
    }

    let _ = app.emit("proxy-done", json!({ "projectId": project_id }));
}

/// Lazy single-clip proxy generation — called when WebView2 fires onError on the source clip.
/// Encodes HEVC (or unknown codec) clips to 480p H.264 using the best available GPU encoder.
async fn run_single_proxy(app: AppHandle, project_id: String, clip: Clip) {
    let appdata = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => {
            eprintln!("[proxy] APPDATA not set");
            return;
        }
    };
    let proxy_dir = format!(r"{}\rushcut\proxies", appdata);
    if let Err(e) = std::fs::create_dir_all(&proxy_dir) {
        eprintln!("[proxy] failed to create proxy dir: {}", e);
    }

    let clip_id = &clip.id;
    let src = &clip.local_path;
    let proxy_path = format!(r"{}\{}.mp4", proxy_dir, clip_id);

    // Skip if a valid proxy already exists on disk
    let needs_encode = if std::path::Path::new(&proxy_path).exists() {
        !is_valid_proxy_file(&proxy_path)
    } else {
        true
    };

    if !needs_encode {
        eprintln!("[proxy] valid proxy already on disk for {}, emitting path", clip_id);
        let _ = update_clip_proxy(clip_id, &proxy_path);
        let _ = app.emit("proxy-progress", json!({
            "projectId": project_id,
            "clipId": clip_id,
            "winPath": proxy_path,
        }));
        return;
    }

    if generate_proxy_file(src, &proxy_path) {
        let _ = update_clip_proxy(clip_id, &proxy_path);
        let _ = app.emit("proxy-progress", json!({
            "projectId": project_id,
            "clipId": clip_id,
            "winPath": proxy_path,
        }));
    } else {
        eprintln!("[proxy] encode failed for clip {}", clip_id);
    }
}

fn emit_error(app: &AppHandle, job_id: &str, message: &str) {
    let _ = app.emit(
        "pipeline-error",
        json!({
            "jobId": job_id,
            "stage": "error",
            "progress": 0,
            "message": message,
            "outputPath": null
        }),
    );
}

/// Convert WSL /mnt/c/... path back to Windows C:\... path.
fn wsl_to_win(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("/mnt/") {
        let mut chars = rest.chars();
        if let Some(drive) = chars.next() {
            let remainder = chars.as_str().replace('/', "\\");
            return format!("{}:{}", drive.to_uppercase(), remainder);
        }
    }
    path.replace('/', "\\")
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Tracks which project IDs currently have a proxy generation in progress.
        // Prevents two concurrent WSL FFmpeg processes writing to the same proxy file
        // when Upload.tsx and Trimmer.tsx both call generate_proxies_cmd.
        .manage(Arc::new(Mutex::new(HashSet::<String>::new())))
        .setup(|app| {
            // Step E splash fix (Batch A): inline overlay in index.html shows on WebView2 load.
            // Emit app-ready once db + WSL check are done — React removes the overlay on this event.
            if let Err(e) = db::init(app.handle()) {
                return Err(e);
            }

            let wsl_ok = std::process::Command::new("wsl")
                .arg("--status")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if wsl_ok {
                eprintln!("[wsl_check] ok");
            } else {
                eprintln!("[wsl_check] FAILED - WSL2 not available");
                app.emit("wsl-check-failed", ()).ok();
            }

            app.emit("app-ready", ()).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            probe_files,
            create_project,
            rename_project_cmd,
            update_clip_review_cmd,
            add_clip_cut_cmd,
            delete_clip_cmd,
            reorder_clips_cmd,
            get_project,
            start_job,
            get_job_cmd,
            list_projects_cmd,
            delete_project_cmd,
            open_output_path,
            generate_proxies_cmd,
            generate_proxy_for_clip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
