mod db;
#[cfg(target_os = "windows")]
mod splash;

use base64::Engine as _;
use db::{
    add_clip_cut, delete_clip, delete_project, get_active_job, get_all_clips_for_bg_proxy, get_all_proxy_paths, get_clips_needing_bg_proxy,
    get_included_clips_with_proxy, get_job, get_latest_render, get_project_output_paths, get_project_with_clips,
    get_stuck_processing_jobs,
    has_4k_clips, insert_clip, insert_job, insert_project, list_projects, rename_project,
    claim_clip_for_encoding, reset_all_encoding_claims, reset_done_with_missing_proxy, reset_stale_encoding_claims, reorder_clips, set_clip_proxy_status,
    set_proxy_for_all_clips_with_path, update_clip_review,
    update_clip_thumbnail, update_clip_volume, update_clip_waveform, update_job_analysis,
    update_job_done, update_job_error, update_job_progress, update_job_stage, Clip, ClipMeta, Job, ProjectSummary,
    ProjectWithClips,
};
use serde_json::json;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
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

/// Resolve the full Windows filesystem path to ffmpeg.exe once and cache it.
/// Python (running in WSL2) cannot call bare "ffmpeg" — it needs the absolute Windows
/// path so it can invoke ffmpeg.exe from WSL via /mnt/c/... or the wsl.localhost UNC path.
static WIN_FFMPEG_PATH: OnceLock<String> = OnceLock::new();

fn resolve_win_ffmpeg_path() -> &'static str {
    WIN_FFMPEG_PATH.get_or_init(|| {
        let output = std::process::Command::new("where")
            .arg("ffmpeg")
            .output()
            .ok();
        if let Some(out) = output {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Some(first) = s.lines().next() {
                    let p = first.trim().to_string();
                    if !p.is_empty() {
                        eprintln!("[encoder] Windows ffmpeg path resolved: {}", p);
                        return p;
                    }
                }
            }
        }
        eprintln!("[encoder] could not resolve Windows ffmpeg path via where.exe -- using 'ffmpeg'");
        "ffmpeg".to_string()
    })
}

/// Detect the best available H.264 encoder once and cache the result.
/// Order: h264_nvenc (Nvidia) → h264_qsv (Intel) → h264_amf (AMD) → libx264 (software).
/// Each candidate is tested with a 1-frame lavfi encode to /dev/null.
static BEST_ENCODER: OnceLock<String> = OnceLock::new();

fn detect_best_encoder() -> &'static str {
    BEST_ENCODER.get_or_init(|| {
        // [S3 Step 2] Probe args: 320x240, 30 frames, yuv420p. AMF rejects any input
        // below 256x256 with "Could not open encoder before EOF" (encoder pipeline
        // refuses to initialize at sub-256 resolutions), silently falling back to
        // libx264 even on AMD machines. The bigger probe also gives nvenc/qsv enough
        // frames to initialize a real session, not just a partial init.
        for enc in &["h264_nvenc", "h264_qsv", "h264_amf"] {
            let output = std::process::Command::new(ffmpeg_exe())
                .args([
                    "-f", "lavfi", "-i", "color=black:s=320x240:r=25",
                    "-vframes", "30", "-pix_fmt", "yuv420p",
                    "-c:v", enc, "-f", "null", "-",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .output();
            match output {
                Ok(out) if out.status.success() => {
                    eprintln!("[encoder-probe] OK selected={}", enc);
                    return enc.to_string();
                }
                Ok(out) => {
                    let err_full = String::from_utf8_lossy(&out.stderr);
                    // Last 6 non-empty lines usually contain the real failure reason
                    let tail: Vec<&str> = err_full
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .rev()
                        .take(6)
                        .collect();
                    let mut tail_rev = tail.clone();
                    tail_rev.reverse();
                    eprintln!(
                        "[encoder-probe] FAIL enc={} exit={:?} stderr-tail={:?}",
                        enc,
                        out.status.code(),
                        tail_rev.join(" | ")
                    );
                }
                Err(e) => {
                    eprintln!("[encoder-probe] SPAWN-ERR enc={} err={}", enc, e);
                }
            }
        }
        eprintln!("[encoder-probe] no GPU encoder available, using libx264 (software)");
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

    let thumbnail_data = extract_thumbnail_piped(&path_str, 1.0);

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

/// Extract a JPEG thumbnail frame at `seek_secs` seek, piped to stdout, returned as a data URI.
/// Uses -map 0:v:0 to skip DJI embedded MJPEG thumbnail in stream 1.
fn extract_thumbnail_piped(src: &str, seek_secs: f64) -> Option<String> {
    let seek = format!("{:.3}", seek_secs.max(0.0));
    let output = std::process::Command::new(ffmpeg_exe())
        .args([
            "-ss", &seek,
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

/// Re-extract a clip's thumbnail at `at_ms` (the trim in-point) and broadcast it (issue #11).
/// Reuses the existing `thumbnail-progress` event so the Trimmer swaps the new frame into
/// both the Media Pantry source tile and the film-strip cut tile live — no new listener.
/// Fire-and-forget from the frontend; the ffmpeg call runs on a blocking pool thread so it
/// never stalls the UI.
#[tauri::command]
async fn regenerate_thumbnail_at_cmd(
    app: AppHandle,
    project_id: String,
    clip_id: String,
    local_path: String,
    at_ms: i64,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let seek = at_ms as f64 / 1000.0;
        if let Some(data) = extract_thumbnail_piped(&local_path, seek) {
            let _ = update_clip_thumbnail(&clip_id, &data);
            let _ = app.emit("thumbnail-progress", json!({
                "projectId": project_id,
                "clipId": clip_id,
                "thumbnailData": data,
            }));
        }
    });
    Ok(())
}

/// Whether a file still exists on disk (issue #55 — used to hide dead "Open film"/"Open folder"
/// actions on the Render done-state when the output has been deleted). Works for both 1080p and
/// 4K, unlike the 1080p-only `<video>` onError signal.
#[tauri::command]
fn file_exists_cmd(path: String) -> bool {
    std::path::Path::new(&path).exists()
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

/// Batch N: append a [PROXY_BG] log line to %TEMP%\rushcut\proxy-bg.log and stderr.
/// Founder validation gate consumes this file directly. Best-effort: a log write
/// failure must NOT block proxy gen.
/// Batch T2 follow-up: ensure %USERPROFILE%\.wslconfig grants WSL2 at least `min_mb` MB.
/// 4K xfade renders need >8 GB (the default) on 16 GB machines — without this they get
/// SIGTERM'd mid-encode. Called once at startup, fire-and-forget.
///
/// Parsing rules (from WSL docs):
///   memory=12GB  → 12 * 1024 MB
///   memory=12288MB → 12288 MB
///   memory=12288  → 12288 MB (unitless = MB in practice)
fn parse_memory_mb(s: &str) -> u64 {
    let s = s.trim();
    if let Some(n) = s.strip_suffix("GB").or_else(|| s.strip_suffix("gb")) {
        n.trim().parse::<u64>().unwrap_or(0).saturating_mul(1024)
    } else if let Some(n) = s.strip_suffix("MB").or_else(|| s.strip_suffix("mb")) {
        n.trim().parse::<u64>().unwrap_or(0)
    } else {
        s.parse::<u64>().unwrap_or(0)
    }
}

fn wslconfig_memory_mb(content: &str) -> u64 {
    let mut in_wsl2 = false;
    for line in content.lines() {
        let t = line.trim();
        if t.eq_ignore_ascii_case("[wsl2]") { in_wsl2 = true; continue; }
        if t.starts_with('[') { in_wsl2 = false; }
        if in_wsl2 {
            if let Some(val) = t.strip_prefix("memory=") {
                return parse_memory_mb(val);
            }
        }
    }
    0
}

fn ensure_wsl_memory(min_mb: u64) {
    let userprofile = match std::env::var("USERPROFILE") {
        Ok(v) => v,
        Err(_) => { eprintln!("[wslconfig] USERPROFILE not set, skipping"); return; }
    };
    let path = std::path::PathBuf::from(&userprofile).join(".wslconfig");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    if wslconfig_memory_mb(&existing) >= min_mb {
        return; // already meets requirement
    }

    // Format memory value (prefer GB when evenly divisible)
    let mem_str = if min_mb % 1024 == 0 {
        format!("{}GB", min_mb / 1024)
    } else {
        format!("{}MB", min_mb)
    };

    let has_wsl2 = existing.lines().any(|l| l.trim().eq_ignore_ascii_case("[wsl2]"));
    let new_content = if !has_wsl2 {
        // Append a fresh [wsl2] section
        let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        format!("{}{}[wsl2]\nmemory={}\nprocessors=8\n", existing, sep, mem_str)
    } else {
        // Update or insert memory= inside the existing [wsl2] section
        let mut out = String::with_capacity(existing.len() + 32);
        let mut in_wsl2 = false;
        let mut written = false;
        for line in existing.lines() {
            let t = line.trim();
            if t.eq_ignore_ascii_case("[wsl2]") {
                in_wsl2 = true;
                out.push_str(line); out.push('\n');
                continue;
            }
            if t.starts_with('[') && in_wsl2 {
                if !written { out.push_str(&format!("memory={}\n", mem_str)); written = true; }
                in_wsl2 = false;
            }
            if in_wsl2 && t.starts_with("memory=") {
                out.push_str(&format!("memory={}\n", mem_str));
                written = true;
                continue;
            }
            out.push_str(line); out.push('\n');
        }
        if in_wsl2 && !written { out.push_str(&format!("memory={}\n", mem_str)); }
        out
    };

    match std::fs::write(&path, &new_content) {
        Ok(_) => eprintln!(
            "[wslconfig] WARNING: set memory={} in {} — run 'wsl --shutdown' once to apply",
            mem_str, path.display()
        ),
        Err(e) => eprintln!("[wslconfig] ERROR: could not write {}: {}", path.display(), e),
    }
}

fn proxy_bg_log(msg: &str) {
    eprintln!("{}", msg);
    let path = std::env::temp_dir().join("rushcut").join("proxy-bg.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{} {}", ts, msg);
    }
}

/// U5c (Issue #2): append a freeze-diagnostic line to %TEMP%\rushcut\playback-trace.log.
/// Called fire-and-forget from the Trimmer on low-frequency, user-driven playback events so the
/// last events before an OS-level GPU TDR freeze survive on disk (flushed per call).
/// Millisecond epoch timestamp -- seek bursts happen within seconds. Mirrors zoom_bg_log.
#[tauri::command]
fn diag_log_cmd(line: String) {
    let path = std::env::temp_dir().join("rushcut").join("playback-trace.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "{} {}", ts, line);
        let _ = f.flush();
    }
}

/// Batch S: record a real-encode proxy timing sample to %TEMP%\rushcut\proxy-timing.json.
/// Skipped for native-codec and cache-hit paths (0s would skew the avg).
/// Keeps last 50 entries; atomic write (tmp → rename) to prevent JSON corruption.
fn record_proxy_timing(elapsed_s: f64, height: u32) {
    let dir = std::env::temp_dir().join("rushcut");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("proxy-timing.json");
    let tmp = dir.join("proxy-timing.json.tmp");

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut entries: Vec<serde_json::Value> = path
        .exists()
        .then(|| std::fs::read(&path).ok())
        .flatten()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    entries.push(json!({ "ts": ts, "elapsed_s": elapsed_s, "height": height }));
    if entries.len() > 50 {
        entries = entries.into_iter().rev().take(50).rev().collect();
    }

    if let Ok(data) = serde_json::to_vec(&entries) {
        let _ = std::fs::write(&tmp, data).and_then(|_| std::fs::rename(&tmp, &path));
    }
}

/// Batch S: return the mean elapsed_s of the last 10 real-encode proxy samples that
/// match the target height (2160 for 4K, 1080 otherwise). Returns None when < 3 samples.
#[tauri::command]
fn get_proxy_avg_timing_cmd(output_resolution: Option<String>) -> Result<Option<f64>, String> {
    let required_h: u32 = if output_resolution.as_deref() == Some("4k") { 2160 } else { 1080 };
    let path = std::env::temp_dir().join("rushcut").join("proxy-timing.json");
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let entries: Vec<serde_json::Value> = serde_json::from_slice(&data).unwrap_or_default();

    let samples: Vec<f64> = entries.iter().rev().take(10)
        .filter_map(|e| {
            let h = e.get("height")?.as_u64()? as u32;
            if h >= required_h { e.get("elapsed_s")?.as_f64() } else { None }
        })
        .collect();

    if samples.len() < 3 {
        return Ok(None);
    }
    let avg = samples.iter().sum::<f64>() / samples.len() as f64;
    Ok(Some(avg))
}

/// Return the video stream height of a proxy file (0 on error).
/// Used to detect legacy 1080p proxies that need upgrading to 2160p for 4K render reuse.
fn proxy_height_native(path: &str) -> u32 {
    let out = std::process::Command::new(ffprobe_exe())
        .args(["-v", "quiet", "-select_streams", "v:0",
               "-show_entries", "stream=height", "-of", "csv=p=0", path])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().unwrap_or(0),
        Err(_) => 0,
    }
}

/// [Q2] Probe native r_frame_rate of a source clip (e.g. "30000/1001" for 29.97fps).
/// Returns None if ffprobe is unavailable or the clip has no video stream.
/// Step 8a: log-only. Do NOT use as an -r argument until the log confirms ffprobe
/// works correctly in the Rust Windows subprocess context.
fn probe_clip_fps(src: &str) -> Option<String> {
    let out = std::process::Command::new(ffprobe_exe())
        .args([
            "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate",
            "-of", "csv=p=0",
            src,
        ])
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.contains('/') { Some(s) } else { None }
        }
        Err(_) => None,
    }
}

/// Batch R: probe a proxy file's video stream height + integer fps in one ffprobe call.
/// Mirrors render.py `_proxy_meta()` so the readiness gate matches the render-time gate.
/// Returns (0, 0) on any error.
fn proxy_meta_native(path: &str) -> (u32, u32) {
    let out = std::process::Command::new(ffprobe_exe())
        .args([
            "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=height,r_frame_rate",
            "-of", "csv=p=0",
            path,
        ])
        .output();
    let stdout = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return (0, 0),
    };
    // ffprobe CSV for one stream looks like "2160,30000/1001"
    let first_line = stdout.lines().next().unwrap_or("");
    let mut parts = first_line.split(',');
    let height = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let fps_str = parts.next().unwrap_or("25");
    let fps_int = round_fps_to_standard(fps_str);
    (height, fps_int)
}

/// Batch R: rounded standard fps from ffprobe rational ("30000/1001" -> 30).
/// Mirrors render.py `round_to_standard_fps`.
fn round_fps_to_standard(s: &str) -> u32 {
    let f = if let Some((num, den)) = s.split_once('/') {
        let n: f64 = num.parse().unwrap_or(0.0);
        let d: f64 = den.parse().unwrap_or(1.0);
        if d == 0.0 { 0.0 } else { n / d }
    } else {
        s.parse::<f64>().unwrap_or(0.0)
    };
    f.round() as u32
}

/// Low-priority background proxy encode — 2160p so proxies qualify for both 1080p and 4K renders.
/// Windows BELOW_NORMAL_PRIORITY_CLASS keeps foreground responsive; -threads 0 lets FFmpeg
/// use all cores on the software HEVC decode, which is the real bottleneck (~7x faster than -threads 1).
/// NOTE: proxy.py was dead code since Batch 16; this native Rust path is the live one.
///
/// [TRAP / Batch S4]: AMF and libx264 need DIFFERENT args. `-preset` / `-crf` are libx264-only;
/// passing them to AMF causes "Could not open encoder before EOF" (silent failure, elapsed=0.1s).
/// Fixed here to mirror the same branching as `generate_proxy_file_normal_priority`.
fn generate_proxy_file_low_priority(src: &str, dst: &str) -> bool {
    let encoder = detect_best_encoder();
    let is_amf = encoder == "h264_amf";
    // [Q2 Step 8b] Use native source fps so proxy matches render target_fps and passes reuse gate.
    // Fallback to "25" if probe fails — renders will reject and re-normalise, no silent regression.
    let fps = probe_clip_fps(src).unwrap_or_else(|| {
        proxy_bg_log(&format!("[Q2] WARNING: fps probe failed for {}, defaulting to 25", src));
        "25".to_string()
    });
    proxy_bg_log(&format!("[PROXY_BG] encode-start src={} dst={} encoder={} fps={}", src, dst, encoder, fps));

    // Build arg list with AMF vs libx264 branching (mirrors generate_proxy_file_normal_priority).
    let mut args: Vec<&str> = vec![
        "-hide_banner", "-loglevel", "error",
        // [#92] Hardware-decode the input HEVC on the GPU. Naming an AMF *output* encoder does
        // NOT hardware-decode the input; without this, FFmpeg software-decodes 4K HEVC at ~1x
        // realtime (the real bottleneck). Decode-only (no -hwaccel_output_format): the software
        // scale filter forces CPU processing regardless, per AMD's FFmpeg-AMF docs. Measured
        // 1.9x faster (92.1s -> 48.6s) on a 52.85s 4K HEVC Main10 clip, driver 31.0.21925.1001.
        "-hwaccel", "d3d11va",
        "-i", src,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", "scale=-2:2160,format=yuv420p",
        "-r", &fps,
        "-fps_mode", "cfr",
        "-c:v", encoder,
    ];
    if is_amf {
        args.extend([
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-rc", "cqp",
            "-qp_i", "30",
            "-qp_p", "30",
            "-quality", "speed",
            // Normalize color primaries so AMF-encoded proxies don't carry
            // prim:reserved. Without these, downstream AMF encodes see prim:reserved
            // on the input and request yuv444p -> swscaler -129 -> fallback (#64).
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
        ]);
    } else {
        args.extend(["-preset", "ultrafast", "-crf", "23"]);
    }
    args.extend([
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        "-threads", "0",
        "-y",
        dst,
    ]);

    let mut cmd = std::process::Command::new(ffmpeg_exe());
    cmd.args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    // Windows: BELOW_NORMAL_PRIORITY_CLASS = 0x00004000 (the natural "nice -n 10" equivalent).
    // Lets foreground UI / thumbnail loads preempt background ffmpeg without starving it.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
        cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS);
    }

    match cmd.output() {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let tail: String = stderr.chars().rev().take(400).collect::<String>().chars().rev().collect();
            proxy_bg_log(&format!("[PROXY_BG] encode-error (low priority) src={} stderr_tail={}", src, tail));
            false
        }
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] encode-spawn-error src={} err={}", src, e));
            false
        }
    }
}

/// Batch R: normal-priority variant of `generate_proxy_file_low_priority` for the
/// Render-screen boost path. Same FFmpeg args except no BELOW_NORMAL priority class
/// and `-threads 0` (auto) so the user's wait state clears faster. Spec must stay
/// in lockstep with the low-priority variant -- both produce the proxy that
/// render.py's reuse gate accepts.
fn generate_proxy_file_normal_priority(src: &str, dst: &str, threads: u32) -> bool {
    let encoder = detect_best_encoder();
    let fps = probe_clip_fps(src).unwrap_or_else(|| {
        proxy_bg_log(&format!("[Q2] WARNING: fps probe failed for {}, defaulting to 25", src));
        "25".to_string()
    });
    // [S3] threads=0 means "auto, all cores" (use when batch is 1 worker).
    // For parallel batches we pass cpu_count/n_workers so the workers don't fight
    // for the same cores.
    let threads_str = threads.to_string();
    let is_amf = encoder == "h264_amf";
    proxy_bg_log(&format!("[PROXY_BG] encode-start (normal priority) src={} dst={} encoder={} fps={} threads={}", src, dst, encoder, fps, threads));

    // [S3] AMF uses different encode-control args than libx264. -preset and -crf
    // are libx264-only; AMF needs -rc cqp + -qp_i/-qp_p + -quality. Passing the
    // wrong args fails AMF init with "Could not open encoder before EOF".
    // QP 30 / quality=speed is the proxy preset (intermediate quality, fast).
    let mut args: Vec<&str> = vec![
        "-hide_banner", "-loglevel", "error",
        // [#92] Hardware-decode the input HEVC on the GPU. Naming an AMF *output* encoder does
        // NOT hardware-decode the input; without this, FFmpeg software-decodes 4K HEVC at ~1x
        // realtime (the real bottleneck). Decode-only (no -hwaccel_output_format): the software
        // scale filter forces CPU processing regardless, per AMD's FFmpeg-AMF docs. Measured
        // 1.9x faster (92.1s -> 48.6s) on a 52.85s 4K HEVC Main10 clip, driver 31.0.21925.1001.
        "-hwaccel", "d3d11va",
        "-i", src,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", "scale=-2:2160,format=yuv420p",
        "-r", &fps,
        "-fps_mode", "cfr",
        "-c:v", encoder,
    ];
    if is_amf {
        args.extend([
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-rc", "cqp",
            "-qp_i", "30",
            "-qp_p", "30",
            "-quality", "speed",
            // Normalize color primaries so AMF-encoded proxies don't carry
            // prim:reserved. Without these, downstream AMF encodes see prim:reserved
            // on the input and request yuv444p -> swscaler -129 -> fallback (#64).
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
        ]);
    } else {
        args.extend([
            "-preset", "ultrafast",
            "-crf", "23",
        ]);
    }
    args.extend([
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        "-threads", threads_str.as_str(),
        "-y",
        dst,
    ]);

    // Capture stderr so failures are diagnosable in proxy-bg.log instead of silently
    // returning `false`. Truncate to last ~400 bytes to keep the log readable.
    let output = std::process::Command::new(ffmpeg_exe())
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output();
    match output {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            let err_full = String::from_utf8_lossy(&out.stderr);
            let tail_idx = err_full.len().saturating_sub(400);
            proxy_bg_log(&format!(
                "[PROXY_BG] ffmpeg-fail encoder={} exit={:?} stderr-tail={:?}",
                encoder,
                out.status.code(),
                &err_full[tail_idx..]
            ));
            false
        }
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] ffmpeg-spawn-err encoder={} err={}", encoder, e));
            false
        }
    }
}

/// Encode a 1080p H.264 proxy using the best available GPU encoder (detected once via OnceLock).
/// Input HEVC is hardware-decoded via `-hwaccel d3d11va` (#92) — naming an AMF *output* encoder
/// does NOT hardware-decode the input; without this flag FFmpeg software-decodes 4K HEVC at ~1x
/// realtime, the real proxy bottleneck. No `-hwaccel_output_format`: the software `scale` filter
/// forces CPU processing regardless (per AMD's own docs), so decode-only accel is the correct shape.
/// Returns true on success.
fn generate_proxy_file(src: &str, dst: &str) -> bool {
    let encoder = detect_best_encoder();
    let is_amf = encoder == "h264_amf";
    // [Q2] Use native source fps so proxy matches render target_fps and passes reuse gate.
    let fps = probe_clip_fps(src).unwrap_or_else(|| "25".to_string());
    eprintln!("[C-proxy] encoding 1080p proxy {} -> {} using {} fps={}", src, dst, encoder, fps);
    // Spec matches normalise.py output so render.py can skip normalise on re-renders:
    //   scale=-2:1080 yuv420p, native fps CFR, GPU/libx264, AAC 48kHz
    // -c:a aac + -ar 48000: DJI records at 96kHz — must re-encode, not stream-copy.
    //
    // [#92] AMF vs libx264 need DIFFERENT encode-control args, same as the two 2160p bg
    // functions. `-preset ultrafast`/`-crf` are libx264-only; passing them to h264_amf fails
    // init ("Unable to parse option value 'ultrafast'", exit 234) and produced NO proxy on
    // AMD machines — the lazy cold-seek path was silently broken before this branch was added.
    let mut args: Vec<&str> = vec![
        "-hwaccel", "d3d11va",
        "-i", src,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", "scale=-2:1080,format=yuv420p",
        "-r", &fps,
        "-fps_mode", "cfr",
        "-c:v", encoder,
    ];
    if is_amf {
        args.extend([
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-rc", "cqp",
            "-qp_i", "30",
            "-qp_p", "30",
            "-quality", "speed",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
        ]);
    } else {
        args.extend(["-preset", "ultrafast", "-crf", "23"]);
    }
    args.extend([
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        "-y",
        dst,
    ]);

    // Capture stderr so failures land in proxy-bg.log instead of being swallowed (#92 root cause).
    match std::process::Command::new(ffmpeg_exe())
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(out) if out.status.success() => {
            eprintln!("[C-proxy] encode OK: {}", dst);
            true
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let tail: String = stderr.chars().rev().take(400).collect::<String>().chars().rev().collect();
            proxy_bg_log(&format!("[C-proxy] encode FAILED encoder={} exit={:?} stderr_tail={}", encoder, out.status.code(), tail));
            false
        }
        Err(e) => {
            proxy_bg_log(&format!("[C-proxy] encode-spawn-error src={} err={}", src, e));
            false
        }
    }
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

/// Called by React on first mount — closes the native splash (Batch A4).
/// The main window is already visible (shown from setup()). The splash sits WS_EX_TOPMOST
/// and physically covers it, so the user only sees splash → app with no intermediate state.
#[tauri::command]
fn confirm_app_loaded(_app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    splash::hide();
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

/// Open a directory in Windows Explorer (no file selection). Works even when
/// the output file has been deleted or moved — navigates to the folder itself.
#[tauri::command]
fn open_folder_cmd(folder: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&folder)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}

/// U4g: open a file in the system DEFAULT player (not Explorer). Used for 4K
/// output, where the in-app WebView2 <video> hits the decode ceiling.
/// `cmd /c start "" "<path>"` invokes ShellExecute semantics and honours the
/// file's default-player association reliably -- launching `explorer.exe` as a
/// file-opener does NOT fire the association correctly on all Windows configs.
/// The empty "" is `start`'s title argument, so a quoted path is not swallowed
/// as the window title.
#[tauri::command]
fn open_in_player_cmd(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| format!("Failed to open in player: {}", e))?;
    Ok(())
}

/// U4g: cancel an in-flight render. Kills the WSL pipeline process group
/// (Python + all ffmpeg children), removes the job's working artifacts, and
/// marks the job failed so the Render screen falls into its error phase.
///
/// Why a process-group kill: `run_pipeline` spawns `wsl.exe -- python3 run.py`,
/// so the Rust-side `child.id()` is the wsl.exe WINDOWS PID, not run.py's Linux
/// PID -- useless for `wsl kill`. Instead run.py calls os.setpgrp() and writes
/// its Linux PID to `%TEMP%\rushcut\<job_id>.pid`; we read that and send
/// `kill -15 -<pid>` (negative = whole group). If the pid file isn't there yet
/// (cancel within ~500ms of start, before run.py wrote it), fall back to
/// `pkill -15 -f <job_id>` -- sufficient, no retry loop.
#[tauri::command]
async fn cancel_render_cmd(app: AppHandle, job_id: String) -> Result<(), String> {
    // Output path (for the defensive partial-file delete) -- read before we
    // touch the row. Note: run.py only copies into processed/ on success, so a
    // mid-render kill usually leaves NO file here; the delete is belt-and-braces.
    let output_path = get_job(&job_id).ok().and_then(|j| j.local_output_path);

    // All blocking work (wsl spawn + filesystem) off the async runtime.
    let job_id_bg = job_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let temp_dir = std::env::temp_dir().join("rushcut");
        let pid_file = temp_dir.join(format!("{}.pid", job_id_bg));

        // 1. Kill the pipeline process group.
        let pid = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok());
        match pid {
            Some(p) => {
                let _ = std::process::Command::new("wsl")
                    .args(["-d", "Ubuntu-24.04", "-u", "root", "--",
                           "kill", "-15", &format!("-{}", p)])
                    .output();
            }
            None => {
                // Fallback: pid file not written yet -- match run.py by job_id.
                let _ = std::process::Command::new("wsl")
                    .args(["-d", "Ubuntu-24.04", "-u", "root", "--",
                           "pkill", "-15", "-f", &job_id_bg])
                    .output();
            }
        }

        // 2. Cleanup. Defensive partial output (usually absent); NTFS working
        //    dir (U1g/U4c segments); WSL /tmp tmpfs dir; the pid file. All
        //    non-fatal -- a missing target is the normal case.
        if let Some(p) = &output_path {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_dir_all(temp_dir.join(&job_id_bg));
        let _ = std::process::Command::new("wsl")
            .args(["-d", "Ubuntu-24.04", "-u", "root", "--",
                   "rm", "-rf", &format!("/tmp/{}", job_id_bg)])
            .output();
        let _ = std::fs::remove_file(&pid_file);
    })
    .await;

    // 3. Mark failed + notify the Render screen (reuses the error-phase wiring).
    let _ = update_job_error(&job_id, "Render cancelled");
    emit_error(&app, &job_id, "Render cancelled");
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

/// Update the per-clip audio volume multiplier (set by user in the Arrange screen, Clips tab).
#[tauri::command]
fn update_clip_volume_cmd(clip_id: String, clip_volume: f64) -> Result<(), String> {
    update_clip_volume(&clip_id, clip_volume)
        .map_err(|e| format!("DB error (update clip volume): {}", e))
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
        clip_volume: 1.0,
        proxy_status: source.proxy_status.clone(),
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
            clip_volume: 1.0,
            proxy_status: None,
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

/// Returns true if the project has any clip with width >= 3840 or height >= 2160.
#[tauri::command]
fn has_4k_clips_cmd(project_id: String) -> Result<bool, String> {
    has_4k_clips(&project_id).map_err(|e| format!("DB error (has_4k_clips): {}", e))
}

/// Start a render job: writes manifest, spawns run.py via WSL, streams progress events.
/// Returns the new job_id immediately (pipeline runs in background).
#[tauri::command]
async fn start_job(
    app: AppHandle,
    project_id: String,
    settings_json: String,
) -> Result<String, String> {
    // Batch U1: single-in-flight-job guard. If a render is already active for
    // this project, re-attach to it instead of spawning a duplicate pipeline.
    // Two concurrent 4K pipelines competing for WSL memory is the prime
    // SIGTERM (exit 15) suspect. Keying on project_id makes this safe across
    // both the user binary and any WDIO process (two-instances-share-one-DB).
    // A long-dead "processing" row can't permanently block: list_projects()
    // auto-fails rows older than 60 min.
    if let Some(active) = get_active_job(&project_id)
        .map_err(|e| format!("DB error (active job guard): {}", e))?
    {
        return Ok(active.id);
    }

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

    // Detect which instance launched this render: WDIO injects a remote-debugging-port arg.
    let instance = if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .map(|v| v.contains("remote-debugging-port"))
        .unwrap_or(false)
    { "wdio" } else { "direct" };

    // Write manifest JSON to Windows TEMP
    let manifest = json!({
        "job_id": job_id,
        "instance": instance,
        // Batch Q: full Windows path to ffmpeg.exe for Python's h264_amf encode path.
        "win_ffmpeg_path": resolve_win_ffmpeg_path(),
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
                "proxy_path": c.proxy_path,
                "proxy_status": c.proxy_status,
                "clip_volume": c.clip_volume,
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
    if let Err(e) = insert_job(&Job {
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
        current_stage: None,
    }) {
        // #89: idx_jobs_active_per_project rejected this insert — another
        // caller won the race and already has an active job for this
        // project. Re-attach to it instead of surfacing an error, mirroring
        // the early get_active_job() check above.
        let is_constraint_violation = matches!(
            &e,
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation
        );
        if is_constraint_violation {
            if let Ok(Some(active)) = get_active_job(&project_id) {
                return Ok(active.id);
            }
            // Winning job already finished (or failed) in the gap between our
            // failed insert and this re-query — nothing to re-attach to, and
            // our own insert didn't happen either. Surface a normal retryable
            // error rather than silently no-op'ing or fabricating a job id.
        }
        return Err(format!("DB error (insert job): {}", e));
    }

    // Notify Library (and any other listeners) that a new job has started so they
    // can add it to their jobsMap before the first pipeline-progress event arrives.
    let _ = app.emit("job-started", json!({ "jobId": job_id, "projectId": project_id }));

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

/// Batch T5: render situation for a project, fetched once on Render-screen mount.
/// `active_job` = an in-flight render to re-attach to; `latest_render` = the most
/// recent completed render to show instead of auto-rendering a fresh one.
#[derive(serde::Serialize)]
struct RenderStatus {
    active_job: Option<Job>,
    latest_render: Option<Job>,
}

#[tauri::command]
fn get_render_status_cmd(project_id: String) -> Result<RenderStatus, String> {
    let active_job = get_active_job(&project_id).map_err(|e| format!("DB error (active job): {}", e))?;
    let latest_render = get_latest_render(&project_id).map_err(|e| format!("DB error (latest render): {}", e))?;
    Ok(RenderStatus { active_job, latest_render })
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

    // Batch R Part C: capture latest ANALYSIS line so the pipeline-done event
    // can carry it to the UI (Render.tsx parses amf_fallback for the toast).
    let mut last_analysis: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if let Some(stage_name) = line.strip_prefix("STAGE:") {
            // Batch U1: persist the stage so the Render screen can restore the
            // label when re-attaching to a render still in progress. Note this
            // is the ONLY place stage is written; the pipeline-progress payload
            // stays { jobId, progress } so it never clobbers the label.
            let _ = update_job_stage(&job_id, stage_name.trim());
            let _ = app.emit(
                "pipeline-stage",
                json!({ "jobId": job_id, "stage": stage_name.trim() }),
            );
        } else if let Some(data) = line.strip_prefix("ANALYSIS:") {
            // Store motion analysis summary from pipeline (Batch 13).
            // Format: clips_used=N,clips_total=M,clips_excluded=X
            let trimmed = data.trim().to_string();
            let _ = update_job_analysis(&job_id, &trimmed);
            last_analysis = Some(trimmed);
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
                    "outputPath": win_out,
                    "analysis": last_analysis,
                }),
            );
            // Fire-and-forget proxy vacuum — delete orphaned/stale proxies on a background thread.
            tauri::async_runtime::spawn_blocking(|| { vacuum_proxies_cmd(); });
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
        // Guard against double-error: cancel_render_cmd may have already marked
        // this job as error ("Cancelled by user") before the pipe-close reaches
        // here. Don't overwrite it with the generic signal-15 message that fires
        // from the same kill (it would confuse acceptance checks + the log).
        let already_error = get_job(&job_id)
            .map(|j| j.status == "error")
            .unwrap_or(false);
        if !already_error {
            let msg = format!("Pipeline exited with status: {}", status);
            let _ = update_job_error(&job_id, &msg);
            emit_error(&app, &job_id, &msg);
        }
    }
}

// ---------------------------------------------------------------------------
// Proxy generation (background)
// ---------------------------------------------------------------------------

/// Batch R: report which include=1 clips are NOT yet render-ready (proxy missing
/// or below the height/fps gate render.py uses). The Render screen polls this
/// before auto-starting so the user never falls into the full-normalise slow
/// path (Q2 fps-rejected proxies = 504s 8-clip render vs 214s baseline).
///
/// Mirrors render.py: `required_proxy_h = 2160 if 4k else 1080`, plus
/// `proxy_fps_int == target_fps_int` (target = native fps of clip 0).
/// A clip with `proxy_path == null`, missing file, height < required, or
/// fps mismatch is "blocking".
#[derive(serde::Serialize)]
struct ProxyReadiness {
    ready: u32,
    total: u32,
    blocking_clip_ids: Vec<String>,
    target_fps_int: u32,
}

#[tauri::command]
fn get_proxy_readiness_cmd(
    project_id: String,
    output_resolution: Option<String>,
) -> Result<ProxyReadiness, String> {
    let clips = get_included_clips_with_proxy(&project_id)
        .map_err(|e| format!("DB error: {}", e))?;

    let total = clips.len() as u32;
    if total == 0 {
        return Ok(ProxyReadiness {
            ready: 0,
            total: 0,
            blocking_clip_ids: vec![],
            target_fps_int: 0,
        });
    }

    let required_h: u32 = if output_resolution.as_deref() == Some("4k") { 2160 } else { 1080 };
    // Target fps derived from clip 0's source — matches render.py `_probe_fps()` semantics.
    let target_fps_int = probe_clip_fps(&clips[0].1)
        .map(|s| round_fps_to_standard(&s))
        .unwrap_or(25);

    let mut ready = 0u32;
    let mut blocking = Vec::new();
    for (id, _local, proxy) in &clips {
        let Some(proxy_path) = proxy else {
            blocking.push(id.clone());
            continue;
        };
        if !std::path::Path::new(proxy_path).exists() {
            blocking.push(id.clone());
            continue;
        }
        let (h, fps_int) = proxy_meta_native(proxy_path);
        if h >= required_h && fps_int == target_fps_int {
            ready += 1;
        } else {
            blocking.push(id.clone());
        }
    }

    Ok(ProxyReadiness {
        ready,
        total,
        blocking_clip_ids: blocking,
        target_fps_int,
    })
}

/// Kick off the upfront media batch (thumbnail + waveform) for all clips in a project.
///
/// Batch N: when `low_priority=true`, additionally pre-encode proxies for clips
/// where `include=1` AND `proxy_status != 'done'`. Triggered on Trimmer unmount —
/// runs serially under BELOW_NORMAL_PRIORITY_CLASS so the user's Arrange/Sound
/// editing window stays responsive.
///
/// Batch S4: `all_clips=true` (Upload-time trigger) encodes ALL scanned clips
/// regardless of include flag — gives the full session time as warm-up buffer.
/// Wasted work on clips the user never includes is acceptable vs waiting at the gate.
///
/// Returns immediately; batch runs in a background task.
#[tauri::command]
async fn generate_proxies_cmd(
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<HashSet<String>>>>,
    project_id: String,
    low_priority: Option<bool>,
    all_clips: Option<bool>,
) -> Result<(), String> {
    let low_priority = low_priority.unwrap_or(false);
    let use_all_clips = all_clips.unwrap_or(false);

    // Concurrency guard: prevents duplicate batches of the same or lower priority.
    // Batch S2: a normal-priority (boost) call is allowed through even when a
    // low-priority batch is already running — the two batches share work safely via
    // the claim_clip_for_encoding DB lock (each clip is encoded by exactly one batch).
    //
    // Key used in the state set:
    //   "{project_id}"         = any batch running (low or normal)
    //   "{project_id}:normal"  = a normal-priority boost is already running
    //
    // A normal-priority boost may pierce the guard once (to run alongside a low-priority
    // batch), but a SECOND concurrent boost is never useful — all unclaimed clips are
    // already being taken by the first boost. Allowing two boosts simultaneously causes
    // three concurrent AMF encodes (low + boost #1 + boost #2), oversubscribing the GPU
    // and multiplying encode time by 3-5x.
    let boost_key = format!("{}:normal", project_id);
    // U1b: track whether this call is a boost (running alongside an in-flight low-priority
    // batch) so cleanup only removes the project_id slot when the MAIN batch finishes.
    // A boost completing early must not remove project_id — that would expose the next
    // Render poll to the 'else' branch, which calls reset_stale_encoding_claims and
    // kills the active claims owned by the still-running main batch.
    let is_boost: bool;
    {
        let mut set = state.lock().unwrap();
        if set.contains(&project_id) {
            if low_priority {
                eprintln!("[proxy] batch already running for project {}, skipping low-priority duplicate", project_id);
                return Ok(());
            }
            // Normal-priority boost: only allow ONE concurrent boost per project.
            if set.contains(&boost_key) {
                eprintln!("[proxy] normal-priority boost already running for project {}, skipping duplicate boost", project_id);
                return Ok(());
            }
            set.insert(boost_key.clone());
            eprintln!("[proxy] boosting project {} — normal-priority batch starting alongside in-flight low-priority batch", project_id);
            is_boost = true;
        } else {
            // First batch for this project — reset stale 'encoding' claims from
            // a prior crashed session (safe only when no concurrent batch is running).
            let _ = reset_stale_encoding_claims(&project_id);
            // U1b: also reset 'done' clips whose proxy file was deleted externally.
            // Without this, encode_one_clip silently skips them (claim returns false for
            // 'done' status) and the Render gate stays stuck at N/total indefinitely.
            if let Ok(n) = reset_done_with_missing_proxy(&project_id) {
                if n > 0 {
                    eprintln!("[proxy] reset {} done-but-missing proxy claims for project {}", n, project_id);
                }
            }
            is_boost = false;
        }
        set.insert(project_id.clone());
    }

    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get clips): {}", e))?;

    let clips_for_media = project_data.clips;
    if clips_for_media.is_empty() {
        let mut s = state.lock().unwrap();
        if !is_boost { s.remove(&project_id); }
        s.remove(&boost_key);
        return Ok(());
    }

    let guard = Arc::clone(&*state);
    let pid = project_id.clone();
    tauri::async_runtime::spawn(async move {
        run_media_batch(app.clone(), pid.clone(), clips_for_media).await;
        // Batch R: always run the proxy batch. The low_priority flag selects
        // priority (BELOW_NORMAL for Trimmer-unmount fire-and-forget vs normal
        // for the Render-screen boost). use_all_clips=true (Upload trigger) encodes
        // all scanned clips; false (Trimmer unmount / Render boost) encodes include=1 only.
        run_bg_proxy_batch(app, pid.clone(), low_priority, use_all_clips).await;
        let mut s = guard.lock().unwrap();
        // U1b: only the main batch (is_boost=false) removes the project_id slot.
        // A boost completing early must NOT remove it — that would expose the next
        // caller to the 'else' branch and reset the main batch's active claims.
        if !is_boost {
            s.remove(&pid);
        }
        s.remove(&format!("{}:normal", pid));
    });

    Ok(())
}

/// Batch T2: FNV-1a 64-bit hash of a byte slice. Used to derive a stable proxy
/// filename from a clip's source `local_path` so that (a) every cut from the same
/// source maps to the same proxy file (dedup), and (b) a source keeps the same
/// proxy filename across app/Rust-toolchain updates (cross-project warm cache).
/// std `DefaultHasher` is explicitly NOT stability-guaranteed across versions, so
/// we roll FNV-1a inline — its algorithm is a fixed contract.
fn fnv1a64(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x00000100000001b3;
    let mut hash = FNV_OFFSET;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Batch T2: stable proxy filename stem for a source file path (no extension).
/// Lower-cased so case-only path differences on Windows map to the same proxy.
fn proxy_name_for_path(local_path: &str) -> String {
    format!("{:016x}", fnv1a64(local_path.to_lowercase().as_bytes()))
}

/// Per-clip encode logic, extracted so parallel workers can share it.
/// Idempotent + safe to call concurrently from multiple workers on the same project
/// thanks to `claim_clip_for_encoding`'s atomic compare-and-set on `proxy_status`.
fn encode_one_clip(
    app: &AppHandle,
    project_id: &str,
    proxy_dir: &str,
    canonical_clip_id: &str,
    local_path: &str,
    codec_name: Option<String>,
    sibling_clip_ids: &[String],
    low_priority: bool,
    threads_per_clip: u32,
) {
    // Codecs WebView2 decodes natively — no transcode needed (matches proxy.py logic).
    const NATIVE_CODECS: &[&str] = &["h264", "vp8", "vp9"];
    let codec = codec_name.unwrap_or_default().to_lowercase();

    // Batch T2: fan-out a finished proxy to every cut sharing this source file.
    // One UPDATE sets proxy_path + proxy_status='done' for all of them; one
    // proxy-progress event per affected clip so each clip's UI (Trimmer source-failed
    // clear, Render readiness) updates.
    let fan_out = |proxy_win_path: &str| {
        match set_proxy_for_all_clips_with_path(project_id, local_path, proxy_win_path) {
            Ok(n) => proxy_bg_log(&format!(
                "[PROXY_BG] fan-out local_path={} proxy_path={} clips_updated={}",
                local_path, proxy_win_path, n
            )),
            Err(e) => proxy_bg_log(&format!("[PROXY_BG] fan-out-error local_path={} err={}", local_path, e)),
        }
        for cid in sibling_clip_ids {
            let _ = app.emit("proxy-progress", json!({
                "projectId": project_id,
                "clipId": cid,
                "winPath": proxy_win_path,
            }));
        }
    };

    // Native codec: source IS the proxy. Mark done immediately, point proxy_path at source.
    if NATIVE_CODECS.contains(&codec.as_str()) {
        proxy_bg_log(&format!("[PROXY_BG] done clip_id={} elapsed=0.0s reason=native-codec codec={}", canonical_clip_id, codec));
        fan_out(local_path);
        return;
    }

    // Batch T2: proxy filename is a stable hash of the SOURCE path, not the clip id.
    // All cuts from the same source share this one file.
    let proxy_path = format!(r"{}\{}.mp4", proxy_dir, proxy_name_for_path(local_path));

    // Already a valid proxy on disk? Only skip re-encode if it is 2160p-compatible.
    // Legacy 1080p proxies (from earlier Batch N sessions before this fix) fall through
    // and get re-encoded at 2160p so they work for both 1080p and 4K renders.
    if std::path::Path::new(&proxy_path).exists() && is_valid_proxy_file(&proxy_path) {
        let h = proxy_height_native(&proxy_path);
        if h >= 2160 {
            proxy_bg_log(&format!("[PROXY_BG] done clip_id={} elapsed=0.0s reason=cached-2160p", canonical_clip_id));
            fan_out(&proxy_path);
            return;
        }
        proxy_bg_log(&format!("[PROXY_BG] upgrade clip_id={} existing-height={}px re-encoding-at-2160p", canonical_clip_id, h));
        // Fall through to re-encode at 2160p.
    }

    // Real encode path (HEVC / unknown).
    // Batch S2: atomic claim — prevents concurrent batches/workers from double-encoding
    // the same source. claim_clip_for_encoding sets proxy_status='encoding' only if
    // no other claim is active (compare-and-set, minimal lock time). Batch T2: the
    // claim is keyed on the canonical clip (MIN(clip_id) per path), which both batch
    // triggers resolve identically — so two concurrent batches never encode one source twice.
    // U1b: if claim returns false and this is the FIRST encode attempt (file missing),
    // the clip's proxy_status is 'done' but the file was deleted — this case is now
    // resolved upstream in generate_proxies_cmd via reset_done_with_missing_proxy.
    // If claim still returns false here, a concurrent batch already owns it — truly skip.
    match claim_clip_for_encoding(canonical_clip_id) {
        Ok(true) => {} // we own this encode slot — proceed
        Ok(false) => {
            proxy_bg_log(&format!("[PROXY_BG] skip clip_id={} reason=already-claimed", canonical_clip_id));
            return;
        }
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] claim-error clip_id={} err={}", canonical_clip_id, e));
            return;
        }
    }

    // Batch T2: encode to a temp file, then atomically rename into place. If two
    // batches ever race the same source despite the claim, distinct temp files +
    // atomic rename guarantee the final {hash}.mp4 is never a half-written file.
    let tmp_path = format!(r"{}\{}.tmp.mp4", proxy_dir, proxy_name_for_path(local_path));
    let _ = std::fs::remove_file(&tmp_path); // clear any stale temp from a crashed run

    proxy_bg_log(&format!("[PROXY_BG] started clip_id={} codec={} low_priority={}", canonical_clip_id, codec, low_priority));
    let t0 = std::time::Instant::now();
    let ok = if low_priority {
        generate_proxy_file_low_priority(local_path, &tmp_path)
    } else {
        generate_proxy_file_normal_priority(local_path, &tmp_path, threads_per_clip)
    };
    let elapsed = t0.elapsed().as_secs_f64();

    if ok && is_valid_proxy_file(&tmp_path) && std::fs::rename(&tmp_path, &proxy_path).is_ok() {
        proxy_bg_log(&format!("[PROXY_BG] done clip_id={} elapsed={:.1}s", canonical_clip_id, elapsed));
        record_proxy_timing(elapsed, 2160);
        fan_out(&proxy_path);
    } else {
        proxy_bg_log(&format!("[PROXY_BG] failed clip_id={} elapsed={:.1}s", canonical_clip_id, elapsed));
        let _ = std::fs::remove_file(&tmp_path); // don't leave a corrupt temp behind
        // Reset the canonical clip to 'queued' so the next batch can re-claim and retry.
        let _ = set_clip_proxy_status(canonical_clip_id, "queued");
    }
}

/// Batch N: background pre-encode of proxies for clips with include=1 AND
/// proxy_status != 'done'. Low-priority runs serial (1 worker, BELOW_NORMAL_PRIORITY_CLASS,
/// -threads 0 = FFmpeg auto) to preserve user responsiveness. Normal-priority (Render gate boost) runs
/// parallel workers — `claim_clip_for_encoding` provides per-clip mutex so
/// workers can race safely on a shared queue. Native-codec sources (H.264 /
/// VP8 / VP9) skip encode and mark done with the source path as proxy_path.
///
/// Batch S4: `all_clips=true` uses `get_all_clips_for_bg_proxy` (no include filter)
/// for Upload-time pre-warm — encodes all scanned clips before user enters Trimmer.
async fn run_bg_proxy_batch(app: AppHandle, project_id: String, low_priority: bool, all_clips: bool) {
    let clips_to_encode = match if all_clips {
        get_all_clips_for_bg_proxy(&project_id)
    } else {
        get_clips_needing_bg_proxy(&project_id)
    } {
        Ok(v) => v,
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] error project_id={} get_clips failed: {}", project_id, e));
            return;
        }
    };

    if clips_to_encode.is_empty() {
        proxy_bg_log(&format!("[PROXY_BG] skip project_id={} reason=no-clips-need-proxy", project_id));
        return;
    }

    // Batch T2: deduplicate by source file. `clips_to_encode` decides WHICH source
    // paths need a proxy (trigger-filtered: all clips vs include=1 only). We then
    // group the project's FULL clip list by `local_path` so that:
    //   - canonical = MIN(clip_id) per path (trigger-agnostic; both batch triggers
    //     resolve the same clip to claim, so concurrent batches never double-encode),
    //   - siblings = every clip sharing the path (fan-out target after the encode).
    // The work queue holds exactly one item per unique source path.
    let all_clips_full = match get_all_clips_for_bg_proxy(&project_id) {
        Ok(v) => v,
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] error project_id={} get_all_clips failed: {}", project_id, e));
            return;
        }
    };
    let paths_to_encode: std::collections::HashSet<String> =
        clips_to_encode.iter().map(|(_, path, _)| path.clone()).collect();
    let mut by_path: std::collections::HashMap<String, Vec<(String, Option<String>)>> =
        std::collections::HashMap::new();
    for (cid, path, codec) in &all_clips_full {
        by_path.entry(path.clone()).or_default().push((cid.clone(), codec.clone()));
    }
    // One work item per unique source path: (canonical_clip_id, local_path, codec, siblings).
    let mut work: Vec<(String, String, Option<String>, Vec<String>)> = Vec::new();
    for path in &paths_to_encode {
        if let Some(clips) = by_path.get(path) {
            let canonical = clips.iter().map(|(c, _)| c.clone()).min().unwrap_or_default();
            let codec = clips.iter()
                .find(|(c, _)| *c == canonical)
                .and_then(|(_, k)| k.clone());
            let siblings: Vec<String> = clips.iter().map(|(c, _)| c.clone()).collect();
            work.push((canonical, path.clone(), codec, siblings));
        }
    }
    let unique_paths = work.len();

    let appdata = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => {
            proxy_bg_log("[PROXY_BG] error APPDATA not set");
            return;
        }
    };
    let proxy_dir = format!(r"{}\rushcut\proxies", appdata);
    let _ = std::fs::create_dir_all(&proxy_dir);

    // [S3] Parallel workers for normal-priority (gate-critical) batch only.
    // Low-priority bg gen keeps 1 worker / -threads 0 (FFmpeg auto); BELOW_NORMAL_PRIORITY_CLASS
    // keeps it out of the way — not single-threading (U1f).
    //
    // GPU-encoder caveat: AMD AMF, Intel QSV, and Nvidia NVENC each expose a
    // limited number of concurrent encode sessions per GPU (typically 1–2 on
    // consumer cards). Spawning multiple concurrent FFmpeg AMF processes triggers
    // "Could not open encoder before EOF" failures on session init. So:
    //   - GPU encoder detected -> n_workers = 1, threads = 0 (serial GPU encode,
    //     which is still ~2x per-clip vs libx264 at threads=0 on this hardware).
    //   - Software libx264 -> n_workers up to 4, threads_per_clip splits cpu count.
    let cpu_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let encoder = detect_best_encoder();
    let is_gpu_encoder = encoder != "libx264";
    // GPU encoders: 2 workers max (AMD H.264 engine + NVENC/QSV all support 2
    // concurrent sessions in practice; >2 starts to fail on session init).
    // libx264: up to 4 workers based on cpu count.
    // Batch T2: worker count sizes off unique source paths (== real encodes), not cut count.
    let n_workers: usize = if low_priority {
        1
    } else if is_gpu_encoder {
        unique_paths.min(2)
    } else {
        unique_paths.min(4).min((cpu_count / 4).max(1))
    };
    let threads_per_clip: u32 = if low_priority || n_workers <= 1 {
        0 // -threads 0 = FFmpeg auto, all cores (only 1 worker so no contention)
    } else {
        ((cpu_count / n_workers).max(1)) as u32
    };

    proxy_bg_log(&format!(
        "[PROXY_BG] batch-start project_id={} clip_count={} unique_paths={} low_priority={} all_clips={} encoder={} n_workers={} threads_per_clip={} cpu_count={}",
        project_id, clips_to_encode.len(), unique_paths, low_priority, all_clips, encoder, n_workers, threads_per_clip, cpu_count
    ));

    // Shared queue, one item per unique source path. Workers pop until empty; the
    // per-canonical-clip DB claim prevents double-encode if a low-priority batch is
    // also running concurrently.
    let queue: Arc<Mutex<Vec<(String, String, Option<String>, Vec<String>)>>> =
        Arc::new(Mutex::new(work));

    let mut handles = Vec::with_capacity(n_workers);
    for worker_idx in 0..n_workers {
        let queue = Arc::clone(&queue);
        let app = app.clone();
        let project_id = project_id.clone();
        let proxy_dir = proxy_dir.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            loop {
                let next = { queue.lock().unwrap().pop() };
                match next {
                    None => {
                        proxy_bg_log(&format!("[PROXY_BG] worker-done idx={} project_id={}", worker_idx, project_id));
                        break;
                    }
                    Some((canonical_clip_id, local_path, codec_name, siblings)) => {
                        encode_one_clip(
                            &app,
                            &project_id,
                            &proxy_dir,
                            &canonical_clip_id,
                            &local_path,
                            codec_name,
                            &siblings,
                            low_priority,
                            threads_per_clip,
                        );
                    }
                }
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    proxy_bg_log(&format!("[PROXY_BG] batch-done project_id={}", project_id));
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
    // Batch T2: proxy filename is a stable hash of the SOURCE path so this lazy
    // on-demand encode shares one file with the dedup background batch and with
    // every other cut of the same source. (NOTE: generate_proxy_file may emit a
    // sub-2160p proxy here; if so the Render readiness gate re-encodes it at 2160p
    // on the next bg pass — rework, not corruption.)
    let proxy_path = format!(r"{}\{}.mp4", proxy_dir, proxy_name_for_path(src));

    // Skip if a valid proxy already exists on disk (shared by all cuts of this source).
    let needs_encode = if std::path::Path::new(&proxy_path).exists() {
        !is_valid_proxy_file(&proxy_path)
    } else {
        true
    };

    if !needs_encode {
        eprintln!("[proxy] valid proxy already on disk for {}, fanning out", clip_id);
        let _ = set_proxy_for_all_clips_with_path(&project_id, src, &proxy_path);
        let _ = app.emit("proxy-progress", json!({
            "projectId": project_id,
            "clipId": clip_id,
            "winPath": proxy_path,
        }));
        return;
    }

    // Batch T2: encode to temp then atomic rename (never expose a half-written file).
    let tmp_path = format!(r"{}\{}.tmp.mp4", proxy_dir, proxy_name_for_path(src));
    let _ = std::fs::remove_file(&tmp_path);
    if generate_proxy_file(src, &tmp_path)
        && is_valid_proxy_file(&tmp_path)
        && std::fs::rename(&tmp_path, &proxy_path).is_ok()
    {
        let _ = set_proxy_for_all_clips_with_path(&project_id, src, &proxy_path);
        let _ = app.emit("proxy-progress", json!({
            "projectId": project_id,
            "clipId": clip_id,
            "winPath": proxy_path,
        }));
    } else {
        let _ = std::fs::remove_file(&tmp_path);
        eprintln!("[proxy] encode failed for clip {}", clip_id);
    }
}

/// Delete proxy files that are orphaned (not referenced by any clip's proxy_path)
/// or stale (>30 days old). Called fire-and-forget after each pipeline-done to keep
/// proxy storage clean.
///
/// Batch T7: reset 'encoding' proxy claims for ONE project back to NULL.
/// Used by the WDIO `after()` hook to clean up the test project before its binary is
/// SIGTERM'd mid-encode — leaving the shared DB free of stuck claims immediately after a
/// run. Scoped to a single project_id so it never touches the user's real projects in the
/// shared DB. Reuses the existing per-project reset_stale_encoding_claims.
#[tauri::command]
fn reset_proxy_encoding_cmd(project_id: String) -> Result<(), String> {
    reset_stale_encoding_claims(&project_id).map_err(|e| format!("DB error (reset claims): {}", e))
}

/// Batch T2: proxies are now named `{hash(local_path)}.mp4`, shared across all cuts
/// from the same source — NOT `{clip_id}.mp4`. Orphan detection therefore keys on the
/// set of distinct `proxy_path` values in the DB (full path match), not clip-id stems.
/// Keying on clip ids here would delete every dedup proxy on the next render.
#[tauri::command]
fn vacuum_proxies_cmd() -> String {
    use std::time::{Duration, SystemTime};

    let appdata = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => return "error=APPDATA not set".to_string(),
    };
    let proxy_dir = format!(r"{}\rushcut\proxies", appdata);

    // Ensure dir exists — no crash on fresh install with no proxies yet
    if let Err(e) = std::fs::create_dir_all(&proxy_dir) {
        return format!("error=cannot create proxy dir: {}", e);
    }

    // Collect every proxy_path currently referenced by a clip (lower-cased for a
    // case-insensitive match against on-disk filenames on Windows).
    let known_proxy_paths: std::collections::HashSet<String> =
        get_all_proxy_paths().unwrap_or_default()
            .into_iter()
            .map(|p| p.to_lowercase())
            .collect();

    let thirty_days = Duration::from_secs(30 * 24 * 3600);
    let cutoff = SystemTime::now()
        .checked_sub(thirty_days)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let entries = match std::fs::read_dir(&proxy_dir) {
        Ok(e) => e,
        Err(e) => return format!("error=read_dir failed: {}", e),
    };

    let mut deleted_orphaned: u32 = 0;
    let mut deleted_stale: u32 = 0;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("mp4") {
            continue;
        }
        // Skip in-flight temp encodes (Batch T2 atomic-rename staging files).
        if path.file_name().and_then(|s| s.to_str()).map(|n| n.ends_with(".tmp.mp4")).unwrap_or(false) {
            continue;
        }

        let full = path.to_string_lossy().to_lowercase();
        let orphaned = !full.is_empty() && !known_proxy_paths.contains(&full);
        let stale = !orphaned && entry.metadata()
            .and_then(|m| m.modified())
            .map(|mtime| mtime < cutoff)
            .unwrap_or(false);

        if orphaned || stale {
            if std::fs::remove_file(&path).is_ok() {
                if orphaned { deleted_orphaned += 1; } else { deleted_stale += 1; }
            }
        }
    }

    let result = format!("deleted_orphaned={},deleted_stale={}", deleted_orphaned, deleted_stale);
    eprintln!("[vacuum] {}", result);
    result
}

/// Return the absolute Windows path to the bundled music directory.
/// Checks for a dev layout (exe inside src-tauri/target/debug/) first,
/// then falls back to a production layout (music/ beside the exe).
#[tauri::command]
fn get_music_dir_cmd() -> String {
    let Ok(exe) = std::env::current_exe() else { return String::new() };
    let Some(exe_dir) = exe.parent() else { return String::new() };

    // Dev path: src-tauri/target/debug/rushcut.exe → ../../.. → project root → music/
    let dev_candidate = exe_dir.join("..").join("..").join("..").join("music");
    if dev_candidate.exists() {
        if let Ok(resolved) = dev_candidate.canonicalize() {
            let s = resolved.to_string_lossy().to_string();
            // canonicalize on Windows may add \\?\ UNC prefix -- strip it so
            // convertFileSrc receives a plain drive-letter path
            return s.strip_prefix("\\\\?\\").map(|v| v.to_string()).unwrap_or(s);
        }
    }

    // Production path: rushcut.exe lives alongside the bundled music/ dir
    let prod_candidate = exe_dir.join("music");
    if prod_candidate.exists() {
        if let Ok(resolved) = prod_candidate.canonicalize() {
            let s = resolved.to_string_lossy().to_string();
            return s.strip_prefix("\\\\?\\").map(|v| v.to_string()).unwrap_or(s);
        }
        return prod_candidate.to_string_lossy().to_string();
    }

    String::new()
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
    // Show native Win32 splash immediately — before WebView2 initialises.
    // Covers the black screen that the HTML #rc-splash overlay cannot address.
    #[cfg(target_os = "windows")]
    splash::show();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of opening a new one.
            let _ = app.get_webview_window("main").map(|w| w.set_focus());
        }))
        .plugin(tauri_plugin_dialog::init())
        // Tracks which project IDs currently have a proxy generation in progress.
        // Prevents two concurrent WSL FFmpeg processes writing to the same proxy file
        // when Upload.tsx and Trimmer.tsx both call generate_proxies_cmd.
        .manage(Arc::new(Mutex::new(HashSet::<String>::new())))
        .setup(|app| {
            // Batch A3: inline #rc-splash overlay in index.html shows on WebView2 load.
            // Batch A4: native Win32 splash covers the earlier black screen (before WebView2 loads).
            if let Err(e) = db::init(app.handle()) {
                return Err(e);
            }

            // Batch T7: reset stale 'encoding' proxy claims left by a crashed/killed binary
            // (e.g. WDIO SIGTERMs its binary mid-encode). Safe at startup: no batch is running
            // in-process yet, and the 900s time-guard never clears a live encode owned by the
            // other binary instance (two-instances-share-one-DB model).
            match reset_all_encoding_claims(900) {
                Ok(n) if n > 0 => eprintln!("[proxy] startup: reset {} stale 'encoding' claim(s)", n),
                Ok(_) => {}
                Err(e) => eprintln!("[proxy] startup: reset_all_encoding_claims failed: {}", e),
            }

            // Batch U1c: self-heal jobs left stuck in 'processing' when the binary was
            // killed mid-render (SIGTERM/crash/WDIO/reboot) while the WSL pipeline kept
            // running. Reconcile each stuck job against the output file on disk.
            // Two scans with asymmetric age guards (done-scan FIRST so a completed
            // >900s job is promoted to done, not failed):
            //   - done: file exists is proof at any age -> 60s guard (avoid racing a row
            //     inserted seconds ago).
            //   - failed: a real render takes 3-12 min, so only fail with no file once the
            //     job is >900s old -- never clobbers a live render in the other binary
            //     (two-instances-share-one-DB), mirroring reset_all_encoding_claims(900).
            // Cheap (a couple of SQLite queries + Path::exists per stuck row); never blocks.
            match get_stuck_processing_jobs(60) {
                Ok(jobs) => {
                    for job in jobs {
                        if let Some(path) = &job.local_output_path {
                            if std::path::Path::new(path).exists() {
                                if let Err(e) = update_job_done(&job.id, path) {
                                    eprintln!("[heal] failed to mark job {} done: {}", job.id, e);
                                } else {
                                    eprintln!("[heal] job {} -> done (output file present on disk)", job.id);
                                }
                            }
                        }
                    }
                }
                Err(e) => eprintln!("[heal] startup: get_stuck_processing_jobs(60) failed: {}", e),
            }
            match get_stuck_processing_jobs(900) {
                Ok(jobs) => {
                    for job in jobs {
                        match &job.local_output_path {
                            // Output path was set but no file exists after 15 min -> the
                            // pipeline died. Fail it so the single-job guard frees for retry.
                            Some(path) if !std::path::Path::new(path).exists() => {
                                if let Err(e) = update_job_error(
                                    &job.id,
                                    "Pipeline did not complete -- please try again",
                                ) {
                                    eprintln!("[heal] failed to mark job {} failed: {}", job.id, e);
                                } else {
                                    eprintln!("[heal] job {} -> failed (no output file after 15 min)", job.id);
                                }
                            }
                            // No output path was ever set: leave it for the 60-min backstop
                            // in list_projects() (job was killed before path was determined).
                            _ => {}
                        }
                    }
                }
                Err(e) => eprintln!("[heal] startup: get_stuck_processing_jobs(900) failed: {}", e),
            }

            // Show the main window so WebView2 / E2E can interact with it.
            // The native splash (WS_EX_TOPMOST) covers it physically until confirm_app_loaded fires.
            if let Some(win) = app.get_webview_window("main") {
                win.show().ok();
            }

            app.emit("app-ready", ()).ok();
            // Native splash is closed by confirm_app_loaded (called from React on first mount).

            // Ensure %USERPROFILE%\.wslconfig grants WSL2 >=12 GB. 4K xfade renders are
            // SIGTERM'd by the kernel on 16 GB machines with the default 8 GB WSL limit.
            // One-time silent write; does NOT restart WSL (user must run 'wsl --shutdown'
            // once, but existing sessions survive — the fix lands on the next WSL start).
            tauri::async_runtime::spawn(async move {
                tokio::task::spawn_blocking(|| ensure_wsl_memory(12288)).await.ok();
            });

            // WSL check moved async — was blocking setup() for 6-8s on every launch.
            // spawn_blocking required: std::process::Command is blocking I/O and must
            // not run directly inside an async task (would stall the thread pool).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let wsl_ok = tokio::task::spawn_blocking(|| {
                    std::process::Command::new("wsl")
                        .arg("--status")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                })
                .await
                .unwrap_or(false);

                if wsl_ok {
                    eprintln!("[wsl_check] ok");
                } else {
                    eprintln!("[wsl_check] FAILED - WSL2 not available");
                    handle.emit("wsl-check-failed", ()).ok();
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            confirm_app_loaded,
            scan_folder,
            probe_files,
            create_project,
            rename_project_cmd,
            update_clip_review_cmd,
            update_clip_volume_cmd,
            add_clip_cut_cmd,
            delete_clip_cmd,
            reorder_clips_cmd,
            get_project,
            has_4k_clips_cmd,
            start_job,
            get_job_cmd,
            get_render_status_cmd,
            list_projects_cmd,
            delete_project_cmd,
            open_output_path,
            open_folder_cmd,
            open_in_player_cmd,
            cancel_render_cmd,
            generate_proxies_cmd,
            get_proxy_readiness_cmd,
            get_proxy_avg_timing_cmd,
            generate_proxy_for_clip,
            vacuum_proxies_cmd,
            reset_proxy_encoding_cmd,
            get_music_dir_cmd,
            diag_log_cmd,
            regenerate_thumbnail_at_cmd,
            file_exists_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
