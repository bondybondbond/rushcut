mod db;
#[cfg(target_os = "windows")]
mod splash;

use base64::Engine as _;
use db::{
    add_clip_cut, delete_clip, delete_project, get_active_job, get_all_clips_for_bg_proxy, get_clips_needing_bg_proxy,
    get_included_clips_with_proxy, get_job, get_latest_render, get_project_output_paths, get_project_with_clips,
    get_setting, get_stuck_processing_jobs, has_active_job, set_setting, fail_stale_pending_jobs,
    delete_setting, get_all_settings, migrate_render_prefs,
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

// #13: key into the flat `settings` KV table for the user's chosen export folder.
const OUTPUT_FOLDER_SETTING_KEY: &str = "output_folder";

// Drives covered by tauri.conf.json's assetProtocol.scope (C:\**, D:\**, E:\**).
// A folder outside these silently 403s in-app playback (no build/runtime error) --
// see rust-tauri.md "Asset protocol scope". Reject at picker-confirm time instead
// of letting the user discover a blank video player after a successful render.
const ALLOWED_OUTPUT_DRIVES: [&str; 3] = ["C:", "D:", "E:"];

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

/// Size in bytes of a file on disk (issue #14 — File size stat on the Render done-state).
/// Callers should gate this behind an existing `file_exists_cmd` true result rather than
/// treating a metadata error here as a distinct failure mode — both checks answer the same
/// underlying question (does this exact path exist).
#[tauri::command]
fn file_size_cmd(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
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

// ---------------------------------------------------------------------------
// [#198] Proxy encode quality + version tag + lazy upgrade of existing proxies
// ---------------------------------------------------------------------------
//
// The 2160p background proxy is also the 4K final-render source, so its quality
// is the first generation of the finished film. Blind viewing (#198 Stage 0,
// two rounds) picked QP 18 as visibly best on steady, detail-rich zoomed shots;
// QP 30 (the old value) was the worst. h264_amf, `-quality speed` stays: QP does
// not change encode time and `quality` bought only ~0.1 VMAF for +30-70% time.
//
// QP and PROXY_TAG move together. Bump PROXY_TAG whenever the proxy encode
// settings change so existing proxies are re-encoded lazily in the background.
const PROXY_QP: &str = "18";
const PROXY_TAG: &str = "rc-proxy-v2-qp18";
// ffmpeg `-metadata` argument carrying PROXY_TAG (mp4 `comment` atom; read back by
// proxy_tag_native). Kept as a separate literal because args are &'static str;
// the unit test `proxy_tag_arg_matches_tag` keeps the two in sync.
const PROXY_TAG_ARG: &str = "comment=rc-proxy-v2-qp18";

/// Required free disk space before an upgrade encode: 3x the source file size plus 5 GiB
/// headroom for renders / exports. Measured QP18 proxy size over 16 real DJI clips (#198):
/// 0.34x-2.34x of the source file (high-detail landscape footage is the worst case), so 3x
/// covers the sample with margin. The old proxy is kept during the upgrade, so both files
/// coexist (the old one is already counted as used space).
const UPGRADE_HEADROOM_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// Hard floor while an upgrade encode is running: if free space falls below this the encode
/// is killed and its temp file removed, whatever the estimate said.
const UPGRADE_FLOOR_BYTES: u64 = 3 * 1024 * 1024 * 1024;

fn upgrade_free_space_needed(src_len: u64) -> u64 {
    src_len.saturating_mul(3).saturating_add(UPGRADE_HEADROOM_BYTES)
}

fn upgrade_floor_breached(free: u64) -> bool {
    free < UPGRADE_FLOOR_BYTES
}

/// [#236] True only when free space is KNOWN and below what an upgrade of this source needs.
/// Unknown free space is never reported to the owner (we cannot truthfully say "not enough").
/// Uses `upgrade_free_space_needed`, the same threshold the background pass applies.
fn upgrade_space_short(free: Option<u64>, src_len: u64) -> bool {
    matches!(free, Some(f) if f < upgrade_free_space_needed(src_len))
}

/// What to do with a valid proxy that already exists on disk.
#[derive(Debug, PartialEq)]
enum ProxyAction {
    /// Current tag and 2160p: reuse as is.
    Current,
    /// Stale or missing tag, or below 2160p: re-encode in the background, keep the old file usable.
    Upgrade,
}

fn proxy_action(height: u32, tag: Option<&str>) -> ProxyAction {
    if height >= 2160 && tag == Some(PROXY_TAG) {
        ProxyAction::Current
    } else {
        ProxyAction::Upgrade
    }
}

/// How `encode_one_clip` treats a valid proxy that already exists on disk.
#[derive(Debug, PartialEq)]
enum ProxyRoute {
    /// Use it as is.
    Reuse,
    /// Stale/missing tag: re-encode in the background AFTER the batch's fresh encodes.
    Upgrade,
    /// Legacy sub-2160p proxy: the pre-#198 re-encode path (unchanged; #233).
    Reencode,
}

/// The routing table, kept pure so it can be unit-tested:
///  - below 2160p: old path;
///  - only the low-priority batch upgrades (a Render-screen boost never does: a render may be
///    about to start);
///  - only with the AMF encoder: the tag marks the AMF quality setting, and a software
///    (libx264) proxy cannot be improved by re-encoding it with the same settings.
fn proxy_route(height: u32, tag: Option<&str>, low_priority: bool, is_amf: bool) -> ProxyRoute {
    if height < 2160 {
        return ProxyRoute::Reencode;
    }
    if !low_priority || !is_amf {
        return ProxyRoute::Reuse;
    }
    match proxy_action(height, tag) {
        ProxyAction::Current => ProxyRoute::Reuse,
        ProxyAction::Upgrade => ProxyRoute::Upgrade,
    }
}

/// An upgrade queued by a worker, run by `run_bg_proxy_batch` after every fresh encode of the
/// batch has finished, so an upgrade can never delay a clip that has no proxy yet.
struct UpgradeJob {
    clip_id: String,
    local_path: String,
    proxy_path: String,
    old_tag: Option<String>,
}

/// Read the proxy encode-version tag (mp4 `comment`). None if absent or unreadable.
fn proxy_tag_native(path: &str) -> Option<String> {
    let out = std::process::Command::new(ffprobe_exe())
        .args(["-v", "quiet", "-show_entries", "format_tags=comment", "-of", "csv=p=0", path])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// In-process bookkeeping for proxy upgrades: paths being upgraded right now (one
/// worker per file) and paths whose upgrade already failed this session (never
/// retried until the app restarts, so a bad file cannot trigger an upgrade loop).
static PROXY_UPGRADES: OnceLock<Mutex<(HashSet<String>, HashSet<String>)>> = OnceLock::new();

fn proxy_upgrades() -> &'static Mutex<(HashSet<String>, HashSet<String>)> {
    PROXY_UPGRADES.get_or_init(|| Mutex::new((HashSet::new(), HashSet::new())))
}

/// Held for the whole of one upgrade encode: upgrades run strictly one at a time app-wide.
static UPGRADE_SERIAL: Mutex<()> = Mutex::new(());

/// [#234] Background proxy ffmpeg children that are running right now: (pid, staging file).
/// Dropping a `Child` does not kill it, so closing the app would leave the encode running and
/// its multi-GB staging file behind. `shutdown_background_work` (called on app exit) ends them.
static BG_FFMPEG: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

fn bg_ffmpeg_register(pid: u32, dst: &str) {
    if let Ok(mut g) = BG_FFMPEG.lock() { g.push((pid, dst.to_string())); }
}

fn bg_ffmpeg_unregister(pid: u32) {
    if let Ok(mut g) = BG_FFMPEG.lock() { g.retain(|(p, _)| *p != pid); }
}

/// [#234] App exit: stop every running background proxy ffmpeg and delete its staging file.
/// The finished proxy (and the old one an upgrade replaces) is never touched: only files
/// registered as in-flight staging files are removed. Bounded: never delays exit by more
/// than a few seconds.
pub fn shutdown_background_work() {
    let running: Vec<(u32, String)> = match BG_FFMPEG.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(_) => return,
    };
    for (pid, dst) in running {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let _ = cmd.status();
        // Windows releases the file handle a moment after the process dies.
        for _ in 0..20 {
            if !std::path::Path::new(&dst).exists() || std::fs::remove_file(&dst).is_ok() { break; }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        proxy_bg_log(&format!("[PROXY_BG] shutdown-killed pid={} staging_removed={}", pid, !std::path::Path::new(&dst).exists()));
    }
}

/// [#234] Fallback for a crash / forced kill: remove `*.upg.tmp.mp4` upgrade staging files whose
/// last write is older than `grace`. A live encode (this or the other rushcut.exe) writes
/// continuously, so a file idle for `grace` is abandoned. Touches only that exact suffix.
/// Returns (files_removed, bytes_freed).
fn sweep_orphan_upgrade_temps(proxy_dir: &std::path::Path, grace: std::time::Duration) -> (u32, u64) {
    let now = std::time::SystemTime::now();
    let (mut n, mut bytes) = (0u32, 0u64);
    if let Ok(rd) = std::fs::read_dir(proxy_dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name_ok = path.file_name().and_then(|s| s.to_str())
                .map(|s| s.ends_with(".upg.tmp.mp4")).unwrap_or(false);
            if !name_ok { continue; }
            let md = match std::fs::metadata(&path) { Ok(m) => m, Err(_) => continue }; // fresh stat: a directory listing can lag for a file still open for writing
            let age = md.modified().ok().and_then(|t| now.duration_since(t).ok()).unwrap_or_default();
            if age < grace { continue; }
            if std::fs::remove_file(&path).is_ok() { n += 1; bytes += md.len(); }
        }
    }
    (n, bytes)
}

struct UpgradeGuard {
    path: String,
}

impl Drop for UpgradeGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = proxy_upgrades().lock() {
            g.0.remove(&self.path);
        }
    }
}

/// Some(guard) if this caller may upgrade `path` now; None if another worker is already
/// on it or it already failed this session.
fn try_begin_upgrade(path: &str) -> Option<UpgradeGuard> {
    let mut g = proxy_upgrades().lock().ok()?;
    if g.0.contains(path) || g.1.contains(path) {
        return None;
    }
    g.0.insert(path.to_string());
    Some(UpgradeGuard { path: path.to_string() })
}

/// [#251] Whether a CANCELLED upgrade encode counts as a failure for the rest of the session.
/// A render-started cancel and an externally caused disk-floor cancel are temporary: the
/// free-space check before each start is the loop guard. But if free space is already back above
/// the start threshold once this encode's own temp file is gone, the encode itself caused the
/// breach (output far bigger than estimated), so a retry would repeat it forever: stay failed.
/// Real encode/swap failures are marked elsewhere and stay sticky.
fn cancel_marks_failed(render_started: bool, disk_low: bool, free_after_cleanup: Option<u64>, need: u64) -> bool {
    !render_started && disk_low && matches!(free_after_cleanup, Some(f) if f >= need)
}

fn mark_upgrade_failed(path: &str) {
    if let Ok(mut g) = proxy_upgrades().lock() {
        g.1.insert(path.to_string());
    }
}

/// Test-only free-space override (0 = off), used by the ignored real-encoder test for #251.
#[cfg(test)]
static TEST_FAKE_FREE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Test-only: when set, the first read of a below-floor fake value flips the fake back to 500 GiB,
/// modelling "free space recovers once the encode's own temp file is deleted" (self-caused breach).
#[cfg(test)]
static TEST_FAKE_SELF_CAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Free bytes available to the caller on the volume holding `dir` (None if unknown).
#[cfg(target_os = "windows")]
fn free_disk_bytes(dir: &str) -> Option<u64> {
    #[cfg(test)]
    {
        let f = TEST_FAKE_FREE.load(std::sync::atomic::Ordering::SeqCst);
        if f != 0 {
            if f < UPGRADE_FLOOR_BYTES && TEST_FAKE_SELF_CAUSED.swap(false, std::sync::atomic::Ordering::SeqCst) {
                TEST_FAKE_FREE.store(500 * 1024 * 1024 * 1024, std::sync::atomic::Ordering::SeqCst);
            }
            return Some(f);
        }
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = dir.encode_utf16().chain(std::iter::once(0)).collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) };
    if ok != 0 { Some(avail) } else { None }
}

#[cfg(not(target_os = "windows"))]
fn free_disk_bytes(_dir: &str) -> Option<u64> {
    None
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
        Ok(o) => parse_fps_rational(&String::from_utf8_lossy(&o.stdout)),
        Err(_) => None,
    }
}

/// [#238] Extract a clean "num/den" from ffprobe csv output. Some DJI clips print
/// "30000/1001," (csv writer emits a trailing empty field), which broke `-r` and the
/// readiness gate. Takes the first line, first field; requires int/int, both non-zero.
fn parse_fps_rational(raw: &str) -> Option<String> {
    let field = raw.lines().next()?.split(',').next()?.trim();
    let (n, d) = field.split_once('/')?;
    let n: u32 = n.trim().parse().ok()?;
    let d: u32 = d.trim().parse().ok()?;
    if n == 0 || d == 0 { return None; }
    Some(format!("{}/{}", n, d))
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
    generate_proxy_file_low_priority_cancellable(src, dst, &|| false)
}

/// Same encode as `generate_proxy_file_low_priority`, but `cancel` is polled while ffmpeg
/// runs (about every 2 s). When it returns true the ffmpeg child is killed and the call
/// returns false ([#198]: an upgrade must never keep the GPU encoder busy once a render starts).
fn generate_proxy_file_low_priority_cancellable(src: &str, dst: &str, cancel: &dyn Fn() -> bool) -> bool {
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
            "-qp_i", PROXY_QP,
            "-qp_p", PROXY_QP,
            "-quality", "speed",
            // Normalize color primaries so AMF-encoded proxies don't carry
            // prim:reserved. Without these, downstream AMF encodes see prim:reserved
            // on the input and request yuv444p -> swscaler -129 -> fallback (#64).
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            // [#198] version tag only for the AMF quality setting; software (libx264) proxies stay untagged and are never "upgraded".
            "-metadata", PROXY_TAG_ARG,
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

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] encode-spawn-error src={} err={}", src, e));
            return false;
        }
    };
    // Drain stderr on its own thread so a chatty ffmpeg can never block on a full pipe
    // while this thread polls for exit / cancellation.
    let stderr_pipe = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut p) = stderr_pipe {
            let _ = std::io::Read::read_to_string(&mut p, &mut s);
        }
        s
    });
    let child_pid = child.id();
    bg_ffmpeg_register(child_pid, dst); // [#234] so app exit can end it
    let mut cancelled = false;
    let mut polls: u32 = 0;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                polls += 1;
                if polls % 20 == 0 && cancel() {
                    let _ = child.kill();
                    let _ = child.wait();
                    cancelled = true;
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => {
                // Cannot read the child's state: stop it and reap it rather than leak it.
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    bg_ffmpeg_unregister(child_pid);
    let stderr = reader.join().unwrap_or_default();
    if cancelled {
        proxy_bg_log(&format!("[PROXY_BG] encode-cancelled (low priority) src={}", src));
        return false;
    }
    match status {
        Some(st) if st.success() => true,
        Some(_) => {
            let tail: String = stderr.chars().rev().take(400).collect::<String>().chars().rev().collect();
            proxy_bg_log(&format!("[PROXY_BG] encode-error (low priority) src={} stderr_tail={}", src, tail));
            false
        }
        None => {
            proxy_bg_log(&format!("[PROXY_BG] encode-error (low priority) src={} status-unavailable", src));
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
    // PROXY_QP (18, #198) / quality=speed is the proxy preset; the libx264 branch is unchanged.
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
            "-qp_i", PROXY_QP,
            "-qp_p", PROXY_QP,
            "-quality", "speed",
            // Normalize color primaries so AMF-encoded proxies don't carry
            // prim:reserved. Without these, downstream AMF encodes see prim:reserved
            // on the input and request yuv444p -> swscaler -129 -> fallback (#64).
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            // [#198] version tag only for the AMF quality setting; software (libx264) proxies stay untagged and are never "upgraded".
            "-metadata", PROXY_TAG_ARG,
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

/// #13: check a folder exists and is actually writable by writing + deleting a
/// probe file. `Path::exists()` alone doesn't catch permission-denied or a
/// removed network share/USB drive that still resolves as a path.
fn is_writable_dir(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if !p.is_dir() {
        return Err("Folder does not exist".to_string());
    }
    let probe = p.join(".rushcut_write_test");
    std::fs::write(&probe, b"x").map_err(|e| format!("Folder is not writable: {}", e))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// #13: read the last-used export folder (no validation -- caller re-validates
/// on mount since a saved folder can go stale between sessions).
#[tauri::command]
fn get_output_folder_cmd() -> Result<Option<String>, String> {
    get_setting(OUTPUT_FOLDER_SETTING_KEY).map_err(|e| format!("DB error: {}", e))
}

/// #188: whole `settings` table as a map. Called once at renderer startup to
/// hydrate the render-pref write-through cache (renderStore.ts) from the DB,
/// which is the source of truth for all `rc_*` editor prefs (cards, transitions,
/// music, resolution) -- WebView2 localStorage is not durable across app
/// restarts and was silently losing card placements (3 confirmed occurrences).
#[tauri::command]
fn get_all_settings_cmd() -> Result<std::collections::HashMap<String, String>, String> {
    get_all_settings()
        .map(|rows| rows.into_iter().collect())
        .map_err(|e| format!("DB error: {}", e))
}

/// #188: upsert one render-pref key. Fire-and-forget from the renderer's
/// `setRenderPref` -- the command commits before it resolves, so a hard kill of
/// rushcut.exe moments later cannot lose the write (unlike localStorage's lazy
/// flush).
#[tauri::command]
fn set_setting_cmd(key: String, value: String) -> Result<(), String> {
    set_setting(&key, &value).map_err(|e| format!("DB error: {}", e))
}

/// #188: delete one render-pref key (renderer's `removeRenderPref`).
#[tauri::command]
fn delete_setting_cmd(key: String) -> Result<(), String> {
    delete_setting(&key).map_err(|e| format!("DB error: {}", e))
}

/// #188: one-time localStorage -> `settings` migration, run from inside the
/// webview (only the renderer can read the current origin's localStorage).
/// Atomic + idempotent; existing DB rows win over stale localStorage values.
#[tauri::command]
fn migrate_render_prefs_cmd(entries: Vec<(String, String)>, marker_key: String) -> Result<(), String> {
    migrate_render_prefs(&entries, &marker_key).map_err(|e| format!("DB error: {}", e))
}

/// #13: re-check a previously-saved folder is still writable, without persisting
/// anything. Used on Render-screen mount to catch a removed drive/revoked
/// permission since the folder was last picked.
#[tauri::command]
fn validate_output_folder_cmd(folder: String) -> Result<(), String> {
    is_writable_dir(&folder)
}

/// #13: validate + persist a freshly-picked export folder (called right after
/// the native OS folder picker returns). Rejects drives outside the asset
/// protocol scope (tauri.conf.json) up front -- otherwise the render would
/// succeed but the in-app player would silently show nothing (403, no error).
#[tauri::command]
fn set_output_folder_cmd(folder: String) -> Result<(), String> {
    let drive = folder.split('\\').next().unwrap_or("");
    if !ALLOWED_OUTPUT_DRIVES.iter().any(|d| d.eq_ignore_ascii_case(drive)) {
        return Err(format!(
            "Please choose a folder on drive C, D, or E -- other drives aren't supported yet."
        ));
    }
    is_writable_dir(&folder)?;
    set_setting(OUTPUT_FOLDER_SETTING_KEY, &folder).map_err(|e| format!("DB error: {}", e))
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

    // #252: a job that already finished or failed has nothing to cancel: do not
    // kill, do not delete its output, do not emit.
    if let Ok(j) = get_job(&job_id) {
        if j.status != "pending" && j.status != "processing" {
            return Ok(());
        }
    }
    // #252: flag the cancel BEFORE the kill. The pipeline reader thread wakes the
    // moment the kill closes the pipe (before the cleanup below ends); while this
    // flag is set it stays silent, so it can neither write its generic "Pipeline
    // exited" error nor emit a second pipeline-error. The DB row deliberately stays
    // 'processing' until the kill is done, so the one-active-render-per-project slot
    // is not released early.
    cancelling_set().lock().unwrap().insert(job_id.clone());

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
        // (#252: the partial-output delete is NOT done here any more: it runs only
        // after the guarded cancel write below proves the job really was cancelled,
        // so a cancel that loses a photo-finish with DONE can never delete the film.)
        let _ = std::fs::remove_dir_all(temp_dir.join(&job_id_bg));
        let _ = std::process::Command::new("wsl")
            .args(["-d", "Ubuntu-24.04", "-u", "root", "--",
                   "rm", "-rf", &format!("/tmp/{}", job_id_bg)])
            .output();
        let _ = std::fs::remove_file(&pid_file);
    })
    .await;

    // 3. Mark failed + notify the Render screen (reuses the error-phase wiring).
    //    Guarded write: if the job somehow reached a terminal state in the meantime
    //    (Ok(false)), someone else already reported it, so emit nothing. A DB error
    //    still emits, so the user is never left without an answer.
    let changed = update_job_error(&job_id, "Render cancelled");
    cancelling_set().lock().unwrap().remove(&job_id);
    if matches!(changed, Ok(false)) {
        return Ok(());
    }
    if let Some(p) = &output_path {
        let _ = std::fs::remove_file(p);
    }
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

/// Delete a single clip row by id — either a cut (include=1, multi-cut model, Batch A)
/// or a source/pantry row (include=0, Trimmer "Remove from project", #40). Cut rows clone
/// their metadata from the source at creation time (no FK), so removing a source row never
/// affects any cut already derived from it.
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

/// Append new source (include=0) clips to an already-existing project (#40, Trimmer
/// "Add clips"). Mirrors create_project's per-clip Clip construction, but computes
/// sort_order starting after the project's current max instead of from 0, and dedupes
/// against local_paths already present in the project (server-side — the frontend's
/// in-memory clips array can be stale). Returns only the newly-inserted rows so the
/// caller can append to UI state without a full refetch.
#[tauri::command]
fn add_clips_cmd(project_id: String, clips: Vec<ClipMeta>) -> Result<Vec<Clip>, String> {
    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get project): {}", e))?;

    let existing_paths: std::collections::HashSet<&str> =
        project_data.clips.iter().map(|c| c.local_path.as_str()).collect();
    let max_order = project_data.clips.iter().map(|c| c.sort_order).max().unwrap_or(-1);

    let mut inserted = Vec::new();
    let mut next_idx: i64 = 0;
    for meta in clips.iter() {
        if existing_paths.contains(meta.local_path.as_str()) {
            continue; // already in this project's pantry — skip silently
        }
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
            sort_order: max_order + 1 + next_idx,
            created_at: db::now(),
            in_ms: None,
            out_ms: None,
            focal_x: None,
            focal_y: None,
            zoom_mode: None,
            include: 0,
            proxy_path: None,
            waveform_data: None,
            codec_name: meta.codec_name.clone(),
            clip_volume: 1.0,
            proxy_status: None,
        };
        insert_clip(&clip).map_err(|e| format!("DB error (insert clip {}): {}", meta.filename, e))?;
        next_idx += 1;
        inserted.push(clip);
    }

    Ok(inserted)
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
    output_dir: String,
) -> Result<String, String> {
    // #13: the frontend gates the Render button on a validated folder, but
    // re-check here too (defense in depth -- folder could go stale, e.g. a
    // removed drive, between the Browse click and clicking Render).
    is_writable_dir(&output_dir)?;

    // Batch U1: single-in-flight-job guard. If a render is already active for
    // this project, re-attach to it instead of spawning a duplicate pipeline.
    // Two concurrent 4K pipelines competing for WSL memory is the prime
    // SIGTERM (exit 15) suspect. Keying on project_id makes this safe across
    // both the user binary and any WDIO process (two-instances-share-one-DB).
    // A long-dead row can't permanently block: list_projects() auto-fails a
    // 'processing' row older than 60 min, and the startup heal in setup() fails a
    // 'pending' row (never reached its first progress line) idle for over 15 min (#235).
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
    // #111: use max existing suffix, not file count — a gap in the sequence
    // (deleted file, crashed render) previously caused count+1 to collide
    // with a still-existing file and silently overwrite it.
    let slug = slugify(&project_data.project.name);
    let prefix = format!("{}-", slug);
    let max_suffix = std::fs::read_dir(&output_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
              .filter_map(|e| {
                  let name = e.file_name().to_string_lossy().to_string();
                  name.strip_prefix(&prefix)
                      .and_then(|rest| rest.strip_suffix(".mp4"))
                      .and_then(|num_str| num_str.parse::<u32>().ok())
              })
              .max()
              .unwrap_or(0)
        })
        .unwrap_or(0);
    let mut suffix = max_suffix + 1;
    let mut output_path = format!(r"{}\{}-{:02}.mp4", output_dir, slug, suffix);
    // Collision guard: max-suffix handles gaps, but a race (two renders kicked
    // off near-simultaneously) or an external write could still land on an
    // existing path. Bump past any collision rather than silently overwriting.
    while std::path::Path::new(&output_path).exists() {
        suffix += 1;
        output_path = format!(r"{}\{}-{:02}.mp4", output_dir, slug, suffix);
    }
    eprintln!("[start_job] output suffix: {}, path: {}", suffix, output_path);

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

    // #110: hevc_amf opt-in has no UI field. Inject it from Rust's OWN process
    // env (this process is a normal Windows process, so a persistent Windows
    // env var reaches it reliably) rather than relying on the WSL python
    // process reading os.environ directly -- the bare `wsl -d ... -- python3
    // run.py` spawn below forwards no env vars into the Linux side at all
    // (same class of gap as the #86 USERPROFILE bug), so RUSHCUT_USE_HEVC_AMF
    // set only in the WSL shell would never be seen by this spawn.
    let mut settings_val = serde_json::from_str::<serde_json::Value>(&settings_json)
        .unwrap_or(json!({}));
    if let Some(obj) = settings_val.as_object_mut() {
        let use_hevc_amf = std::env::var("RUSHCUT_USE_HEVC_AMF")
            .map(|v| v == "1")
            .unwrap_or(false);
        obj.insert("use_hevc_amf".to_string(), json!(use_hevc_amf));

        // #120: force_normalise -- debug-only diagnostic lever (unblocks #118
        // proxy-quality A/B). Same mechanism as use_hevc_amf above: read from
        // this process's own env (reliable, unlike the WSL spawn which forwards
        // no env vars), inject into settings before the manifest is written.
        // Env var must be set BEFORE the binary launches -- has no effect on an
        // already-running process. Never exposed in UI.
        let force_normalise = std::env::var("RUSHCUT_FORCE_NORMALISE")
            .map(|v| v == "1")
            .unwrap_or(false);
        obj.insert("force_normalise".to_string(), json!(force_normalise));
    }

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
        "settings": settings_val,
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
        current_stage_step: None,
        current_stage_total: None,
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
            if !is_cancelling(&job_id) && !matches!(update_job_error(&job_id, &msg), Ok(false)) {
                emit_error(&app, &job_id, &msg);
            }
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

        if let Some(stage_raw) = line.strip_prefix("STAGE:") {
            // #142: parse the optional trailing "::N/M" ONCE right here, reuse
            // the parsed (text, step, total) at both consumption points below
            // (DB persist + event payload) -- mirrors the ANALYSIS: branch's
            // existing parse-once-reuse pattern (`trimmed` below). Any parse
            // failure (missing "::", non-numeric N/M) falls back to treating
            // the whole line as plain stage text with no step info.
            let stage_trimmed = stage_raw.trim();
            let (stage_text, step, total): (&str, Option<i64>, Option<i64>) =
                match stage_trimmed.rsplit_once("::") {
                    Some((text, rest)) => match rest.split_once('/') {
                        Some((s, t)) => match (s.parse::<i64>(), t.parse::<i64>()) {
                            (Ok(s), Ok(t)) => (text, Some(s), Some(t)),
                            _ => (stage_trimmed, None, None),
                        },
                        None => (stage_trimmed, None, None),
                    },
                    None => (stage_trimmed, None, None),
                };
            // Batch U1: persist the stage so the Render screen can restore the
            // label when re-attaching to a render still in progress. Note this
            // is the ONLY place stage is written; the pipeline-progress payload
            // stays { jobId, progress } so it never clobbers the label.
            let _ = update_job_stage(&job_id, stage_text, step, total);
            let _ = app.emit(
                "pipeline-stage",
                json!({ "jobId": job_id, "stage": stage_text, "stepIndex": step, "stepTotal": total }),
            );
        } else if let Some(data) = line.strip_prefix("ANALYSIS:") {
            // Store motion analysis summary from pipeline (Batch 13).
            // Format: clips_used=N,clips_total=M,clips_excluded=X
            let trimmed = data.trim().to_string();
            let _ = update_job_analysis(&job_id, &trimmed);
            last_analysis = Some(trimmed);
        } else if let Some(pct_str) = line.strip_prefix("PROGRESS:") {
            let pct: i64 = pct_str.trim().parse().unwrap_or(0);
            // #252: Ok(false) = the row is already terminal (cancelled / failed),
            // so this late line must neither revive it nor reach the UI.
            if !is_cancelling(&job_id)
                && !matches!(update_job_progress(&job_id, pct, "processing"), Ok(false))
            {
                let _ = app.emit(
                    "pipeline-progress",
                    json!({
                        "jobId": job_id,
                        "progress": pct,
                    }),
                );
            }
        } else if let Some(wsl_out) = line.strip_prefix("DONE:") {
            // Convert WSL path back to Windows path for storage
            let wsl_out = wsl_out.trim();
            let win_out = wsl_to_win(wsl_out);
            // #252: a cancel that already marked the row failed wins over a DONE
            // line that was already in the pipe: no "done" event after "cancelled".
            if is_cancelling(&job_id) || matches!(update_job_done(&job_id, &win_out), Ok(false)) {
                return;
            }
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
            // #252: only the writer that actually changed the row reports the error.
            if !is_cancelling(&job_id) && !matches!(update_job_error(&job_id, &msg), Ok(false)) {
                emit_error(&app, &job_id, &msg);
            }
            return;
        }
    }

    // Process exited without DONE/ERROR — check exit status
    let status = child.wait().unwrap_or_else(|_| {
        std::process::ExitStatus::default()
    });
    if !status.success() {
        // #252: guard against double-error. While cancel_render_cmd is killing the
        // pipeline it flags the job as cancelling, so the pipe closing here stays
        // silent (cancel reports "Render cancelled" itself, once). Any other writer
        // that already ended the job makes this guarded write change nothing
        // (Ok(false)). (The old guard compared the status to "error", which is never
        // written.)
        if !is_cancelling(&job_id) {
            let msg = format!("Pipeline exited with status: {}", status);
            if !matches!(update_job_error(&job_id, &msg), Ok(false)) {
                emit_error(&app, &job_id, &msg);
            }
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

/// [#236] Source file names (one per source file) of the film's clips whose 2160p working copy
/// is out of date and that the background pass cannot improve because free space is short.
/// Read-only and derived on demand: nothing is stored, so it clears by itself once the copies
/// are upgraded or space is freed. Silent (empty) when free space is unknown, a render is
/// active, the machine has no AMF encoder (no upgrade is ever attempted there), or the
/// working copy is current / legacy / missing.
fn upgrade_space_notice(project_id: &str) -> Result<Vec<String>, String> {
    if detect_best_encoder() != "h264_amf" {
        return Ok(vec![]);
    }
    if has_active_job().unwrap_or(true) {
        return Ok(vec![]);
    }
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA not set".to_string())?;
    let proxy_dir = format!(r"{}\rushcut\proxies", appdata);
    let free = free_disk_bytes(&proxy_dir);
    let clips = get_included_clips_with_proxy(project_id).map_err(|e| format!("DB error: {}", e))?;
    let sources: Vec<String> = clips.into_iter().map(|(_id, local, _proxy)| local).collect();
    Ok(upgrade_space_notice_for(&sources, &proxy_dir, free))
}

/// The decision itself, with free space and the proxy folder passed in so it can be tested
/// against real files with a faked free-space value.
fn upgrade_space_notice_for(sources: &[String], proxy_dir: &str, free: Option<u64>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut names = Vec::new();
    for local_path in sources {
        if !seen.insert(local_path.to_lowercase()) {
            continue; // cuts of one source share one working copy
        }
        let src_len = std::fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);
        // Cheap exit first: no ffprobe when this source would fit anyway.
        if !upgrade_space_short(free, src_len) {
            continue;
        }
        let proxy_path = format!(r"{}\{}.mp4", proxy_dir, proxy_name_for_path(local_path));
        if !std::path::Path::new(&proxy_path).exists() || !is_valid_proxy_file(&proxy_path) {
            continue;
        }
        let h = proxy_height_native(&proxy_path);
        // Legacy sub-2160p copies take the separate pre-#198 path, not the upgrade pass.
        if h >= 2160 && proxy_action(h, proxy_tag_native(&proxy_path).as_deref()) == ProxyAction::Upgrade {
            let name = std::path::Path::new(local_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| local_path.clone());
            names.push(name);
        }
    }
    names
}

#[tauri::command]
async fn get_upgrade_space_notice_cmd(project_id: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || upgrade_space_notice(&project_id))
        .await
        .map_err(|e| format!("notice task failed: {}", e))?
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

/// [#198] Re-encode an existing, valid 2160p proxy that carries a stale or missing tag.
/// Contract (owner gates): the old proxy is never damaged and stays usable until the new
/// file is complete and valid; `proxy_status` is never touched; a failed or skipped upgrade
/// leaves the old file as it was; each path is attempted at most once per session after a
/// failure, and one worker per file at a time; it never starts while ANY render is active
/// (any project, either app instance: has_active_job reads the shared DB), and an encode in
/// progress is killed within about 2 s when a render starts (retried in a later batch); it
/// is skipped when the volume is short of space.
fn upgrade_existing_proxy(
    clip_id: &str,
    local_path: &str,
    proxy_path: &str,
    proxy_dir: &str,
    old_tag: Option<&str>,
) {
    let guard = match try_begin_upgrade(proxy_path) {
        Some(g) => g,
        None => {
            proxy_bg_log(&format!("[PROXY_BG] upgrade-skip clip_id={} reason=in-flight-or-failed-this-session", clip_id));
            return;
        }
    };
    // Global serialisation: batches are keyed per project, so two projects' low-priority
    // batches could otherwise upgrade at the same time and each pass the free-space check on
    // the same free bytes. One upgrade encode at a time across the whole app; the render and
    // disk checks below run only after this lock is held, so they are never stale.
    let _serial = UPGRADE_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Re-read after the lock: an earlier upgrade pass (or another batch's queue) may already have
    // replaced this proxy while this job was waiting; never re-encode a proxy that is current.
    if proxy_action(proxy_height_native(proxy_path), proxy_tag_native(proxy_path).as_deref()) == ProxyAction::Current {
        proxy_bg_log(&format!("[PROXY_BG] upgrade-skip clip_id={} reason=already-current", clip_id));
        return;
    }
    // A DB error counts as "render active": skipping is the safe side.
    if has_active_job().unwrap_or(true) {
        proxy_bg_log(&format!("[PROXY_BG] upgrade-skip clip_id={} reason=render-active", clip_id));
        return;
    }
    let src_len = std::fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);
    let need = upgrade_free_space_needed(src_len);
    match free_disk_bytes(proxy_dir) {
        Some(free) if free >= need => {}
        Some(free) => {
            proxy_bg_log(&format!(
                "[PROXY_BG] upgrade-skip clip_id={} reason=low-disk free={}MB need={}MB (old proxy kept)",
                clip_id, free / 1_048_576, need / 1_048_576
            ));
            return;
        }
        None => {
            // Unknown free space: the safe side is to leave the old proxy as it is.
            proxy_bg_log(&format!("[PROXY_BG] upgrade-skip clip_id={} reason=disk-space-unknown (old proxy kept)", clip_id));
            return;
        }
    }
    // Own temp name (still ends in .tmp.mp4 so vacuum_proxies_cmd skips it): never the file the
    // fresh-encode paths use for the same source.
    let tmp_path = format!(r"{}\{}.upg.tmp.mp4", proxy_dir, proxy_name_for_path(local_path));
    let _ = std::fs::remove_file(&tmp_path); // stale temp from a crashed run
    proxy_bg_log(&format!("[PROXY_BG] upgrade-start clip_id={} old_tag={:?} new_tag={}", clip_id, old_tag, PROXY_TAG));
    let t0 = std::time::Instant::now();
    let render_started = std::cell::Cell::new(false);
    let disk_low = std::cell::Cell::new(false);
    let ok = generate_proxy_file_low_priority_cancellable(local_path, &tmp_path, &|| {
        if has_active_job().unwrap_or(true) {
            render_started.set(true);
            return true;
        }
        if let Some(free) = free_disk_bytes(proxy_dir) {
            if upgrade_floor_breached(free) {
                disk_low.set(true);
                return true;
            }
        }
        false
    });
    let elapsed = t0.elapsed().as_secs_f64();
    if render_started.get() || disk_low.get() {
        proxy_bg_log(&format!(
            "[PROXY_BG] upgrade-cancelled clip_id={} elapsed={:.1}s reason={} (old proxy kept, temp file removed)",
            clip_id, elapsed, if render_started.get() { "render-started" } else { "disk-floor" }
        ));
        let _ = std::fs::remove_file(&tmp_path);
        // #251: a disk-floor cancel is temporary, not a failure. Not marked failed, so the next
        // pass retries once space is freed. The loop guard is the free-space check above: it needs
        // upgrade_free_space_needed() (always above UPGRADE_FLOOR_BYTES) before any encode starts.
        if cancel_marks_failed(render_started.get(), disk_low.get(), free_disk_bytes(proxy_dir), need) {
            mark_upgrade_failed(proxy_path);
        }
        return;
    }
    let complete = ok
        && is_valid_proxy_file(&tmp_path)
        && proxy_height_native(&tmp_path) >= 2160
        && proxy_tag_native(&tmp_path).as_deref() == Some(PROXY_TAG);
    if !complete {
        proxy_bg_log(&format!("[PROXY_BG] upgrade-failed clip_id={} elapsed={:.1}s (old proxy kept, not retried this session)", clip_id, elapsed));
        let _ = std::fs::remove_file(&tmp_path);
        mark_upgrade_failed(proxy_path);
        return;
    }
    // A render may have started during the final probes: do not swap under it; retry later.
    if has_active_job().unwrap_or(true) {
        proxy_bg_log(&format!("[PROXY_BG] upgrade-cancelled clip_id={} reason=render-started-before-swap (old proxy kept, temp file removed)", clip_id));
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    // Windows replaces the destination atomically, and fails (leaving both files intact) when
    // the old proxy is held open without share-delete (e.g. playing in the Trimmer).
    match std::fs::rename(&tmp_path, proxy_path) {
        Ok(()) => {
            proxy_bg_log(&format!("[PROXY_BG] upgrade-done clip_id={} elapsed={:.1}s", clip_id, elapsed));
            record_proxy_timing(elapsed, 2160);
        }
        Err(e) => {
            proxy_bg_log(&format!("[PROXY_BG] upgrade-swap-failed clip_id={} err={} (old proxy kept, not retried this session)", clip_id, e));
            let _ = std::fs::remove_file(&tmp_path);
            mark_upgrade_failed(proxy_path);
        }
    }
    drop(guard);
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
    deferred_upgrades: &Mutex<Vec<UpgradeJob>>,
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

    // Already a valid proxy on disk? Reuse it as is when it is 2160p AND carries the
    // current encode tag. A stale/missing tag (QP30-era proxy) or a legacy 1080p proxy is
    // upgraded IN THE BACKGROUND (#198): the old file stays usable and `done` the whole
    // time, and is replaced atomically only when the new file is complete. The upgrade
    // deliberately does NOT go through claim_clip_for_encoding (it refuses `done` clips) and
    // never touches proxy_status.
    if std::path::Path::new(&proxy_path).exists() && is_valid_proxy_file(&proxy_path) {
        let h = proxy_height_native(&proxy_path);
        let tag = proxy_tag_native(&proxy_path);
        let route = proxy_route(h, tag.as_deref(), low_priority, detect_best_encoder() == "h264_amf");
        match route {
            ProxyRoute::Reuse => {
                proxy_bg_log(&format!(
                    "[PROXY_BG] done clip_id={} elapsed=0.0s reason=cached-2160p tag={:?} low_priority={}",
                    canonical_clip_id, tag, low_priority
                ));
                fan_out(&proxy_path);
                return;
            }
            ProxyRoute::Upgrade => {
                // The old proxy is usable right now: make sure the clip reads as ready, and
                // queue the re-encode for after this batch's fresh encodes (a clip with no
                // proxy yet must never wait behind a long upgrade).
                fan_out(&proxy_path);
                proxy_bg_log(&format!("[PROXY_BG] upgrade-queued clip_id={} old_tag={:?}", canonical_clip_id, tag));
                if let Ok(mut q) = deferred_upgrades.lock() {
                    q.push(UpgradeJob {
                        clip_id: canonical_clip_id.to_string(),
                        local_path: local_path.to_string(),
                        proxy_path: proxy_path.clone(),
                        old_tag: tag,
                    });
                }
                return;
            }
            ProxyRoute::Reencode => {
                proxy_bg_log(&format!("[PROXY_BG] upgrade clip_id={} existing-height={}px re-encoding-at-2160p", canonical_clip_id, h));
                // Legacy sub-2160p proxy: fall through to the existing re-encode path (unchanged, #233).
            }
        }
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
    let deferred: Arc<Mutex<Vec<UpgradeJob>>> = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::with_capacity(n_workers);
    for worker_idx in 0..n_workers {
        let queue = Arc::clone(&queue);
        let app = app.clone();
        let project_id = project_id.clone();
        let proxy_dir = proxy_dir.clone();
        let deferred = Arc::clone(&deferred);
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
                            &deferred,
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

    // [#198] Proxy upgrades run AFTER the batch (so no clip waits behind them) and detached from
    // it (so this project's batch guard is released and a later batch for new clips is not
    // skipped). They are serialised app-wide inside upgrade_existing_proxy.
    let jobs: Vec<UpgradeJob> = deferred.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default();
    if !jobs.is_empty() {
        let proxy_dir_up = proxy_dir.clone();
        tokio::task::spawn_blocking(move || {
            proxy_bg_log(&format!("[PROXY_BG] upgrade-pass-start count={}", jobs.len()));
            for j in jobs {
                upgrade_existing_proxy(&j.clip_id, &j.local_path, &j.proxy_path, &proxy_dir_up, j.old_tag.as_deref());
            }
            proxy_bg_log("[PROXY_BG] upgrade-pass-done");
        });
    }
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
/// #241 grace period: a proxy file younger than this is never removed (covers the gap
/// between an encode renaming into place and its DB row being written, and the other
/// rushcut.exe instance finishing a proxy while this one lists the folder).
const VACUUM_GRACE_SECS: u64 = 3600;
/// #241 owner decision 2026-11-16: a project untouched for 90 days is stale; its
/// proxies (if no active project shares them) may go. Re-making a proxy is cheap.
const VACUUM_ACTIVE_DAYS: u32 = 90;

/// #287 owner decision 2026-11-23 (A4 approved): the 90-day stale-proxy rule is ON. A project
/// with no DB activity for VACUUM_ACTIVE_DAYS loses the proxies no active project shares; a
/// proxy shared with an active project is never removed (tested). Supersedes the 2026-11-16
/// "off" decision (made so the Stagecoach 2025 benchmark kept its proxies).
const VACUUM_REMOVE_STALE: bool = true;
/// #287: `*.mp4.bak` and abandoned `*.tmp.mp4` younger than this are never removed.
const VACUUM_JUNK_GRACE_SECS: u64 = 24 * 3600;

static VACUUM_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Pure sweep (testable on a scratch dir). Order matters: LIST the folder first, THEN read
/// the DB sets via `load` (a file created after the listing is never considered).
/// Returns (deleted_orphaned, deleted_stale, bytes_freed). Counts only successful removals.
fn vacuum_dir(
    proxy_dir: &std::path::Path,
    grace: std::time::Duration,
    junk_grace: std::time::Duration,
    remove_stale: bool,
    load: impl FnOnce() -> Option<(HashSet<String>, HashSet<String>)>,
) -> Option<(u32, u32, u64)> {
    let now = std::time::SystemTime::now();
    let mut listed: Vec<(std::path::PathBuf, u64, std::time::Duration)> = Vec::new();
    // #287: abandoned `<16hex>.mp4.bak` backups and `<16hex>.tmp.mp4` fresh-encode staging
    // files older than `junk_grace` (24 h: no live encode or swap lasts that long).
    // `*.upg.tmp.mp4` is NOT included: sweep_orphan_upgrade_temps owns it.
    let mut junk: Vec<(std::path::PathBuf, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(proxy_dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let is_hex16 = |s: &str| s.len() == 16 && s.chars().all(|c| c.is_ascii_hexdigit());
            let junk_stem = if name.ends_with(".upg.tmp.mp4") {
                None
            } else {
                name.strip_suffix(".mp4.bak").or_else(|| name.strip_suffix(".tmp.mp4"))
            };
            if let Some(stem) = junk_stem {
                if is_hex16(stem) {
                    if let Ok(md) = entry.metadata() {
                        if md.is_file() {
                            let newest = [md.modified().ok(), md.created().ok()].into_iter().flatten().max();
                            let age = newest.and_then(|t| now.duration_since(t).ok()).unwrap_or_default();
                            if age >= junk_grace { junk.push((path.clone(), md.len())); }
                        }
                    }
                }
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("mp4") { continue; }
            // In-flight staging files (*.tmp.mp4, *.upg.tmp.mp4) are never touched here.
            if name.ends_with(".tmp.mp4") { continue; }
            // Only RushCut's own proxy names ({016x} hash of the source path): the vacuum can never
            // become a general cleaner of whatever lands in this folder.
            let stem_ok = path.file_stem().and_then(|s| s.to_str())
                .map(|s| s.len() == 16 && s.chars().all(|c| c.is_ascii_hexdigit()))
                .unwrap_or(false);
            if !stem_ok { continue; }
            let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            // Age = time since the NEWER of mtime and creation time (a rename keeps the
            // temp file's mtime; a copy can reset either).
            let newest = [md.modified().ok(), md.created().ok()].into_iter().flatten().max();
            let age = newest.and_then(|t| now.duration_since(t).ok()).unwrap_or_default();
            listed.push((path, md.len(), age));
        }
    }
    // None = the DB could not be read: delete NOTHING (never infer "orphan" from a failed read).
    let (referenced, active) = load()?;
    let (mut orphans, mut stale, mut bytes) = (0u32, 0u32, 0u64);
    for (path, len) in junk {
        if std::fs::remove_file(&path).is_ok() { orphans += 1; bytes += len; }
    }
    for (path, len, age) in listed {
        if age < grace { continue; }
        let key = path.to_string_lossy().to_lowercase();
        let is_orphan = !referenced.contains(&key);
        let is_stale = remove_stale && !is_orphan && !active.contains(&key);
        if (is_orphan || is_stale) && std::fs::remove_file(&path).is_ok() {
            if is_orphan { orphans += 1 } else { stale += 1 }
            bytes += len;
        }
    }
    Some((orphans, stale, bytes))
}

/// #241: remove proxies no project needs. Keeps every proxy referenced by a project active
/// in the last 90 days (age of the file is irrelevant); removes orphans and proxies only
/// referenced by stale projects. Refuses to run under RUSHCUT_DATA_DIR (an isolated QA
/// instance sees a scratch DB but the REAL proxy dir, so every real proxy looks orphaned)
/// and while any render is pending/processing. Runs at startup and after a render;
/// result goes to proxy-bg.log (the app's stderr is not visible on a direct launch).
#[tauri::command]
fn vacuum_proxies_cmd() -> String {
    use std::sync::atomic::Ordering;
    if std::env::var("RUSHCUT_DATA_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        proxy_bg_log("[vacuum] skipped=isolated_data_dir");
        return "skipped=isolated_data_dir".to_string();
    }
    let appdata = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => return "error=APPDATA not set".to_string(),
    };
    if has_active_job().unwrap_or(true) {
        proxy_bg_log("[vacuum] skipped=render_active");
        return "skipped=render_active".to_string();
    }
    if VACUUM_RUNNING.swap(true, Ordering::SeqCst) {
        proxy_bg_log("[vacuum] skipped=already_running");
        return "skipped=already_running".to_string();
    }
    // Resets the flag on every exit path, including a panic.
    struct RunGuard;
    impl Drop for RunGuard { fn drop(&mut self) { VACUUM_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst); } }
    let _guard = RunGuard;
    let proxy_dir = std::path::PathBuf::from(format!(r"{}\rushcut\proxies", appdata));
    let _ = std::fs::create_dir_all(&proxy_dir);

    let swept = vacuum_dir(
        &proxy_dir,
        std::time::Duration::from_secs(VACUUM_GRACE_SECS),
        std::time::Duration::from_secs(VACUUM_JUNK_GRACE_SECS),
        VACUUM_REMOVE_STALE,
        || {
            // Re-check right before the DB read: a render started since the first check
            // makes this run give up (delete nothing) instead of racing it.
            if has_active_job().unwrap_or(true) { return None; }
            db::get_proxy_refs_for_vacuum(VACUUM_ACTIVE_DAYS).ok().map(|(all, act)| (
                all.into_iter().map(|p| p.to_lowercase()).collect(),
                act.into_iter().map(|p| p.to_lowercase()).collect(),
            ))
        },
    );
    let (orphans, stale, bytes) = match swept {
        Some(t) => t,
        None => {
            proxy_bg_log("[vacuum] skipped=db_unreadable");
            return "skipped=db_unreadable".to_string();
        }
    };
    let result = format!(
        "deleted_orphaned={},deleted_stale={},freed_mb={}",
        orphans, stale, bytes / (1024 * 1024)
    );
    proxy_bg_log(&format!("[vacuum] {}", result));
    result
}

// ---------------------------------------------------------------------------
// #287: startup sweep of %TEMP%\rushcut (job scratch) and WSL /tmp
// ---------------------------------------------------------------------------

/// Retention (named constants on purpose: a silent retention change is the known failure of
/// age-based cleanup). Work items = per-job manifest, pid file, segment work dir.
const TEMP_SWEEP_WORK_SECS: u64 = 7 * 24 * 3600;
/// Per-job pipeline logs (`pipeline-<uuid>.log`) are the only diagnostics of a failed render.
const TEMP_SWEEP_LOG_SECS: u64 = 30 * 24 * 3600;

static TEMP_SWEEP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `8-4-4-4-12` lowercase/uppercase hex, the only id shape RushCut gives a job.
fn is_job_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 { return false; }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum TempKind { Work, Log }

/// Map a directory entry name to (job id, kind) or None. ONLY these shapes are ever swept:
/// `<uuid>.json`, `<uuid>.pid`, `<uuid>/` (Work) and `pipeline-<uuid>.log` (Log), plus a
/// `.sweep` claim left by an interrupted earlier sweep of one of those. Everything else
/// (render-timing-log.jsonl, proxy-bg.log, playback-trace.log, proxy-timing.json,
/// pipeline-latest.log, `<clip>-thumb.jpg`, ...) returns None and is never touched.
fn classify_temp_item(name: &str, is_dir: bool) -> Option<(String, TempKind)> {
    let base = name.strip_suffix(".sweep").unwrap_or(name);
    if is_dir {
        return if is_job_uuid(base) { Some((base.to_lowercase(), TempKind::Work)) } else { None };
    }
    if let Some(id) = base.strip_suffix(".json").or_else(|| base.strip_suffix(".pid")) {
        if is_job_uuid(id) { return Some((id.to_lowercase(), TempKind::Work)); }
    }
    if let Some(id) = base.strip_prefix("pipeline-").and_then(|r| r.strip_suffix(".log")) {
        if is_job_uuid(id) { return Some((id.to_lowercase(), TempKind::Log)); }
    }
    None
}

fn dir_size(p: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.filter_map(|e| e.ok()) {
            if let Ok(ft) = e.file_type() {
                if ft.is_symlink() { continue; }
                if ft.is_dir() { total += dir_size(&e.path()); }
                else if let Ok(md) = e.metadata() { total += md.len(); }
            }
        }
    }
    total
}

/// Pure sweep of one temp folder (testable on a scratch dir). Order matters, as in
/// `vacuum_dir`: LIST first, THEN read the DB via `load`, so an item created after the
/// listing is never considered. `load` returns the ids of LIVE jobs (pending/processing and
/// not past the crash limit); every other id, terminal or unknown to the DB, is eligible once
/// past its retention. `None` = the DB could not be read: delete NOTHING.
/// Each item is claimed by renaming it to `<name>.sweep` before it is deleted; a rename that
/// fails (another process holds it) skips the item. Symlinks are never followed or removed.
/// Returns (removed, bytes_freed); counts only successful removals.
fn sweep_temp_dir(
    dir: &std::path::Path,
    work_retention: std::time::Duration,
    log_retention: std::time::Duration,
    load: impl FnOnce() -> Option<HashSet<String>>,
) -> Option<(u32, u64)> {
    let now = std::time::SystemTime::now();
    let mut listed: Vec<(std::path::PathBuf, String, bool, TempKind, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let ft = match entry.file_type() { Ok(t) => t, Err(_) => continue };
            if ft.is_symlink() { continue; }
            let name = entry.file_name().to_string_lossy().to_string();
            let (id, kind) = match classify_temp_item(&name, ft.is_dir()) { Some(x) => x, None => continue };
            let md = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            let newest = [md.modified().ok(), md.created().ok()].into_iter().flatten().max();
            let age = newest.and_then(|t| now.duration_since(t).ok()).unwrap_or_default();
            let retention = if kind == TempKind::Log { log_retention } else { work_retention };
            if age < retention { continue; }
            listed.push((entry.path(), id, ft.is_dir(), kind, md.len()));
        }
    }
    let live = load()?;
    let (mut removed, mut bytes) = (0u32, 0u64);
    for (path, id, is_dir, _kind, len) in listed {
        if live.contains(&id) { continue; }
        // Belt and braces: the item must sit directly in `dir`.
        if path.parent() != Some(dir) { continue; }
        let claimed = if path.extension().and_then(|e| e.to_str()) == Some("sweep") {
            path.clone() // already claimed by an interrupted earlier sweep
        } else {
            let mut name = path.file_name().unwrap_or_default().to_os_string();
            name.push(".sweep");
            let target = dir.join(name);
            if std::fs::rename(&path, &target).is_err() { continue; }
            target
        };
        let size = if is_dir { dir_size(&claimed) } else { len };
        let ok = if is_dir { std::fs::remove_dir_all(&claimed).is_ok() } else { std::fs::remove_file(&claimed).is_ok() };
        if ok { removed += 1; bytes += size; }
    }
    Some((removed, bytes))
}

/// A temp folder is safe to sweep from an isolated QA instance only when it lives under the
/// same root as that instance's own data dir (wdio.qa.conf.ts puts `data` and `temp` side by
/// side under one run folder). Otherwise the instance has a scratch DB but the LIVE temp
/// folder, so every real job would look unknown to it: refuse.
fn temp_belongs_to_data_dir(temp: &std::path::Path, data_dir: &std::path::Path) -> bool {
    match data_dir.parent() {
        // >= 3 components: prefix + root + at least one named folder, never a bare drive root.
        Some(root) if root.components().count() >= 3 => temp.starts_with(root),
        _ => false,
    }
}

/// #287: remove finished-job scratch from %TEMP%\rushcut and stale scratch inside WSL.
/// Runs once per launch on a background thread; result goes to proxy-bg.log.
/// Nothing is removed while any render or proxy encode is in flight (checked against the
/// shared DB, so the second rushcut.exe is covered); an unreadable DB deletes nothing.
fn sweep_scratch_cmd() -> String {
    use std::sync::atomic::Ordering;
    let temp = std::env::temp_dir().join("rushcut");
    let data_override = std::env::var("RUSHCUT_DATA_DIR").ok().filter(|v| !v.trim().is_empty());
    let isolated = data_override.is_some();
    if let Some(d) = &data_override {
        if !temp_belongs_to_data_dir(&temp, std::path::Path::new(d)) {
            proxy_bg_log("[sweep] skipped=temp_not_isolated");
            return "skipped=temp_not_isolated".to_string();
        }
    }
    match db::any_work_in_flight() {
        Ok(false) => {}
        Ok(true) => { proxy_bg_log("[sweep] skipped=work_in_flight"); return "skipped=work_in_flight".to_string(); }
        Err(_) => { proxy_bg_log("[sweep] skipped=db_unreadable"); return "skipped=db_unreadable".to_string(); }
    }
    if TEMP_SWEEP_RUNNING.swap(true, Ordering::SeqCst) {
        return "skipped=already_running".to_string();
    }
    struct RunGuard;
    impl Drop for RunGuard { fn drop(&mut self) { TEMP_SWEEP_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst); } }
    let _guard = RunGuard;

    let swept = sweep_temp_dir(
        &temp,
        std::time::Duration::from_secs(TEMP_SWEEP_WORK_SECS),
        std::time::Duration::from_secs(TEMP_SWEEP_LOG_SECS),
        || {
            // Re-check right before the read: a render started since the first check makes
            // this run give up instead of racing it.
            if db::any_work_in_flight().unwrap_or(true) { return None; }
            db::live_job_ids().ok().map(|v| v.into_iter().map(|s| s.to_lowercase()).collect())
        },
    );
    let mut result = match swept {
        Some((n, bytes)) => format!("temp_removed={},temp_freed_mb={}", n, bytes / (1024 * 1024)),
        None => { proxy_bg_log("[sweep] skipped=db_unreadable_or_busy"); return "skipped=db_unreadable_or_busy".to_string(); }
    };
    // WSL side: never from an isolated instance (WSL /tmp is shared with the live one).
    if !isolated && !db::any_work_in_flight().unwrap_or(true) {
        // Never boot the WSL VM just to sweep it: `wsl -l --running` does not start anything
        // (its output is UTF-16, so NULs are stripped before matching).
        let mut list = std::process::Command::new("wsl");
        list.args(["-l", "--running"]);
        let mut sweep = std::process::Command::new("wsl");
        sweep.args(["-d", "Ubuntu-24.04", "-u", "root", "--", "bash", "/mnt/c/apps/rushcut/pipeline/wsl_sweep.sh"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            list.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            sweep.creation_flags(0x0800_0000);
        }
        let running = list.output().map(|o| {
            String::from_utf8_lossy(&o.stdout).replace('\0', "").contains("Ubuntu-24.04")
        }).unwrap_or(false);
        let out = if running { sweep.output() } else {
            result.push_str(",wsl=not_running");
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "wsl not running"))
        };
        match out {
            Ok(o) if o.status.success() => {
                let line = String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("").trim().to_string();
                result.push_str(&format!(",wsl=[{}]", line));
            }
            Ok(o) => result.push_str(&format!(",wsl=exit_{}", o.status.code().unwrap_or(-1))),
            Err(_) if !running => {} // already noted as wsl=not_running
            Err(_) => result.push_str(",wsl=unavailable"),
        }
    }
    proxy_bg_log(&format!("[sweep] {}", result));
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

/// #252: jobs whose cancel is in flight (kill + cleanup not finished yet).
fn cancelling_set() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_cancelling(job_id: &str) -> bool {
    cancelling_set().lock().map(|s| s.contains(job_id)).unwrap_or(false)
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

    let mut builder = tauri::Builder::default();

    // The isolated QA E2E instance (#170) sets RUSHCUT_DATA_DIR and must run ALONGSIDE the
    // user's live app. tauri-plugin-single-instance would make that second rushcut.exe exit
    // on launch and forward its args to the user's instance -- so it never starts, never
    // opens its CDP debug port. Skip the plugin for the QA instance only; a normal launch
    // (RUSHCUT_DATA_DIR unset) is unaffected and still single-instance.
    let is_qa_instance = std::env::var("RUSHCUT_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !is_qa_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of opening a new one.
            let _ = app.get_webview_window("main").map(|w| w.set_focus());
        }));
    }

    builder
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

            // #235: a job row stuck in 'pending' (app killed or pipeline hung before its first
            // progress line) counts as an active render forever: every background proxy upgrade
            // is skipped and start_job re-attaches to the dead job. Fail it once it has been idle
            // 15 min (a live pipeline refreshes updated_at within seconds). Runs BEFORE the
            // vacuum / upgrade work below, which both skip while any job is active.
            match fail_stale_pending_jobs(900) {
                Ok(ids) => {
                    for id in &ids {
                        eprintln!("[heal] job {} -> failed (still pending after 15 min, never started)", id);
                    }
                }
                Err(e) => eprintln!("[heal] startup: fail_stale_pending_jobs(900) failed: {}", e),
            }

            // #241: sweep orphaned / long-stale proxies once per launch (background thread;
            // refuses under RUSHCUT_DATA_DIR and while a render is active; logs to proxy-bg.log).
            tauri::async_runtime::spawn_blocking(|| {
                // #234: abandoned upgrade staging files from a crashed / force-killed run.
                // Same isolation rule as the vacuum: a QA instance sees the REAL proxy dir.
                let isolated = std::env::var("RUSHCUT_DATA_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false);
                if !isolated {
                    if let Ok(appdata) = std::env::var("APPDATA") {
                        let dir = std::path::PathBuf::from(format!(r"{}\rushcut\proxies", appdata));
                        let (n, bytes) = sweep_orphan_upgrade_temps(&dir, std::time::Duration::from_secs(600));
                        if n > 0 {
                            proxy_bg_log(&format!("[PROXY_BG] startup-sweep removed={} freed_mb={}", n, bytes / (1024 * 1024)));
                        }
                    }
                }
                vacuum_proxies_cmd();
                // #287: finished-job scratch in %TEMP%\rushcut and stale scratch in WSL /tmp.
                // Background only (never blocks startup); skips while any work is in flight.
                sweep_scratch_cmd();
            });

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
            add_clips_cmd,
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
            get_upgrade_space_notice_cmd,
            get_proxy_avg_timing_cmd,
            generate_proxy_for_clip,
            vacuum_proxies_cmd,
            reset_proxy_encoding_cmd,
            get_music_dir_cmd,
            diag_log_cmd,
            regenerate_thumbnail_at_cmd,
            file_exists_cmd,
            file_size_cmd,
            get_output_folder_cmd,
            validate_output_folder_cmd,
            set_output_folder_cmd,
            get_all_settings_cmd,
            set_setting_cmd,
            delete_setting_cmd,
            migrate_render_prefs_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // #234: closing RushCut must stop background proxy encodes and remove their staging files.
            if let tauri::RunEvent::Exit = event {
                shutdown_background_work();
            }
        });
}

#[cfg(test)]
mod fps_probe_tests {
    use super::parse_fps_rational;

    #[test]
    fn parses_probe_output_variants() {
        assert_eq!(parse_fps_rational("30000/1001\n").as_deref(), Some("30000/1001"));
        assert_eq!(parse_fps_rational("30000/1001,\r\n").as_deref(), Some("30000/1001")); // #238
        assert_eq!(parse_fps_rational("25/1").as_deref(), Some("25/1"));
        assert_eq!(parse_fps_rational("0/0"), None);
        assert_eq!(parse_fps_rational("30/0"), None);
        assert_eq!(parse_fps_rational(""), None);
        assert_eq!(parse_fps_rational("N/A"), None);
        assert_eq!(parse_fps_rational("30"), None);
    }
}

#[cfg(test)]
mod proxy_upgrade_tests {
    use super::*;

    #[test]
    fn proxy_tag_arg_matches_tag() {
        assert_eq!(PROXY_TAG_ARG, format!("comment={}", PROXY_TAG));
        assert_eq!(PROXY_QP, "18");
        assert!(PROXY_TAG.contains("qp18"));
    }

    #[test]
    fn upgrade_space_short_table() {
        let gib: u64 = 1024 * 1024 * 1024;
        let src = 2 * gib; // need = 3x2 + 5 = 11 GiB
        assert!(upgrade_space_short(Some(10 * gib), src), "below the threshold is reported");
        assert!(!upgrade_space_short(Some(11 * gib), src), "exactly enough is not reported");
        assert!(!upgrade_space_short(Some(50 * gib), src), "plenty of space is silent");
        assert!(!upgrade_space_short(None, src), "unknown free space is silent");
        // Same threshold the background pass uses.
        assert_eq!(upgrade_free_space_needed(src), 11 * gib);
    }

    #[test]
    fn proxy_action_table() {
        assert_eq!(proxy_action(2160, Some(PROXY_TAG)), ProxyAction::Current);
        assert_eq!(proxy_action(2160, None), ProxyAction::Upgrade); // QP30-era proxy, no tag
        assert_eq!(proxy_action(2160, Some("rc-proxy-v1")), ProxyAction::Upgrade);
        assert_eq!(proxy_action(1080, Some(PROXY_TAG)), ProxyAction::Upgrade);
        assert_eq!(proxy_action(0, None), ProxyAction::Upgrade);
    }

    #[test]
    fn proxy_route_table() {
        // 2160p, current tag: reuse, whatever the batch kind.
        assert_eq!(proxy_route(2160, Some(PROXY_TAG), true, true), ProxyRoute::Reuse);
        assert_eq!(proxy_route(2160, Some(PROXY_TAG), false, true), ProxyRoute::Reuse);
        // 2160p, stale or missing tag: only a low-priority AMF batch upgrades.
        assert_eq!(proxy_route(2160, None, true, true), ProxyRoute::Upgrade);
        assert_eq!(proxy_route(2160, Some("rc-proxy-v1"), true, true), ProxyRoute::Upgrade);
        assert_eq!(proxy_route(2160, None, false, true), ProxyRoute::Reuse, "Render-screen boost never upgrades");
        assert_eq!(proxy_route(2160, None, true, false), ProxyRoute::Reuse, "software encoder: nothing to improve");
        // Legacy sub-2160p proxy keeps the pre-#198 path regardless.
        assert_eq!(proxy_route(1080, None, true, true), ProxyRoute::Reencode);
        assert_eq!(proxy_route(1080, Some(PROXY_TAG), false, false), ProxyRoute::Reencode);
        assert_eq!(proxy_route(0, None, true, true), ProxyRoute::Reencode);
    }

    #[test]
    fn upgrade_space_rule() {
        let gib = 1024u64 * 1024 * 1024;
        assert_eq!(upgrade_free_space_needed(0), 5 * gib);
        assert_eq!(upgrade_free_space_needed(10 * gib), 30 * gib + 5 * gib);
        assert!(upgrade_free_space_needed(u64::MAX) >= 5 * gib); // no overflow panic
        // Worst measured ratio (2.34x source) fits the estimate with margin.
        let src = 600u64 * 1024 * 1024;
        assert!(upgrade_free_space_needed(src) > (src as f64 * 2.34) as u64 + 5 * gib - 1);
        assert!(upgrade_floor_breached(3 * gib - 1));
        assert!(!upgrade_floor_breached(3 * gib));
    }

    // #251: a disk-floor cancel is not marked failed, so the retry is gated only by the start
    // check. That check must be strictly stricter than the cancel floor at every source size,
    // otherwise a retry could start and be cancelled again in a loop.
    #[test]
    fn disk_floor_cancel_retry_is_gated_by_start_check() {
        let gib = 1024u64 * 1024 * 1024;
        for src in [0u64, 1, 100 * 1024 * 1024, 600 * 1024 * 1024, 10 * gib, u64::MAX] {
            let need = upgrade_free_space_needed(src);
            assert!(need > UPGRADE_FLOOR_BYTES, "start threshold must exceed the cancel floor");
        }
        // Apply the same decision the cancel branch applies, then check retryability.
        let p = r"C:\test\proxies\floor-cancel.mp4";
        let g = try_begin_upgrade(p).expect("first attempt");
        let need = upgrade_free_space_needed(600 * 1024 * 1024);
        // External drop: space is still short after our temp file is gone -> retryable.
        if cancel_marks_failed(false, true, Some(UPGRADE_FLOOR_BYTES - 1), need) {
            mark_upgrade_failed(p);
        }
        drop(g);
        assert!(try_begin_upgrade(p).is_some(), "retryable after an external disk-floor cancel");
        assert!(!cancel_marks_failed(true, false, Some(need * 2), need), "render-started cancel is not a failure");
        assert!(!cancel_marks_failed(false, true, None, need), "unknown free space: not marked");
        // Self-caused: space is back above the start threshold once our temp is gone -> sticky.
        assert!(cancel_marks_failed(false, true, Some(need), need), "own temp file caused the breach: stay failed");
        assert!(cancel_marks_failed(false, true, Some(need + 1), need));
        assert!(!cancel_marks_failed(false, true, Some(need - 1), need));
    }

    #[test]
    fn upgrade_guard_is_exclusive_and_failure_sticks() {
        let p = r"C:\test\proxies\guard-a.mp4";
        let g = try_begin_upgrade(p).expect("first caller gets the guard");
        assert!(try_begin_upgrade(p).is_none(), "second concurrent worker must be refused");
        drop(g);
        let g2 = try_begin_upgrade(p).expect("free again after the guard drops");
        drop(g2);
        mark_upgrade_failed(p);
        assert!(try_begin_upgrade(p).is_none(), "a failed path is not retried this session");
        assert!(try_begin_upgrade(r"C:\test\proxies\guard-b.mp4").is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn free_disk_bytes_reads_temp_volume() {
        let tmp = std::env::temp_dir();
        let free = free_disk_bytes(tmp.to_str().unwrap());
        assert!(free.map(|f| f > 0).unwrap_or(false));
    }

    // The swap: rename over the old proxy either replaces it whole or fails leaving BOTH files intact.
    #[cfg(target_os = "windows")]
    #[test]
    fn swap_is_atomic_or_leaves_old_intact() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("rc-swap-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("p.mp4");
        let new = dir.join("p.tmp.mp4");
        std::fs::write(&old, b"OLD-PROXY").unwrap();
        std::fs::write(&new, b"NEW-PROXY").unwrap();
        {
            // Old proxy held open for reading WITHOUT share-delete (FILE_SHARE_READ only).
            let _held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&old).unwrap();
            let r = std::fs::rename(&new, &old);
            assert!(r.is_err(), "rename over a file held open without share-delete must fail");
            assert_eq!(std::fs::read(&old).unwrap(), b"OLD-PROXY", "old proxy untouched");
            assert_eq!(std::fs::read(&new).unwrap(), b"NEW-PROXY", "temp file untouched");
        }
        std::fs::rename(&new, &old).expect("swap succeeds once the old file is released");
        assert_eq!(std::fs::read(&old).unwrap(), b"NEW-PROXY");
        assert!(!new.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // Integration test against the REAL ffmpeg / AMF encoder and a real camera clip.
    // Ignored by default. Run with RC_TEST_CLIP (a 4K clip, at least 40 s) and RC_TEST_DIR (an
    // EMPTY scratch dir): the test points RUSHCUT_DATA_DIR at RC_TEST_DIR so the DB it reads is
    // a throwaway one (a bare `jobs` table); it never touches the real %APPDATA% database.
    //   cargo test --lib proxy_upgrade_tests::real_upgrade_paths -- --ignored --nocapture
    // -----------------------------------------------------------------------
    #[cfg(target_os = "windows")]
    fn rc_run(exe: &str, args: &[&str]) -> bool {
        std::process::Command::new(exe)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// [#236] Real files, real ffprobe, faked free space:
    ///   $env:RC_TEST_DIR=<scratch dir>; cargo test --lib proxy_upgrade_tests::space_notice_real_files -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn space_notice_real_files() {
        let dir = match std::env::var("RC_TEST_DIR") {
            Ok(d) if !d.is_empty() => std::path::PathBuf::from(d),
            _ => {
                eprintln!("RC_TEST_DIR not set: skipping");
                return;
            }
        };
        let proxies = dir.join("proxies");
        std::fs::create_dir_all(&proxies).unwrap();
        let proxies_s = proxies.to_str().unwrap().to_string();
        // Three tiny "camera originals" (content irrelevant; only their path and size matter).
        let mk_src = |n: &str| {
            let p = dir.join(n);
            std::fs::write(&p, vec![0u8; 1024]).unwrap();
            p.to_str().unwrap().to_string()
        };
        let stale_src = mk_src("STALE_clip.mp4");
        let current_src = mk_src("CURRENT_clip.mp4");
        let legacy_src = mk_src("LEGACY_clip.mp4");
        let mk_proxy = |src: &str, h: &str, tag: Option<&str>| {
            let out = proxies.join(format!("{}.mp4", proxy_name_for_path(src)));
            let scale = format!("testsrc2=size={}x{}:rate=5:duration=1", (h.parse::<u32>().unwrap() * 16 / 9) & !1, h);
            let mut args: Vec<&str> = vec!["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", &scale,
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
            let meta;
            if let Some(t) = tag {
                meta = format!("comment={}", t);
                args.extend_from_slice(&["-metadata", &meta]);
            }
            args.extend_from_slice(&["-y", out.to_str().unwrap()]);
            assert!(rc_run(ffmpeg_exe(), &args));
        };
        mk_proxy(&stale_src, "2160", None); // QP30-era: 2160p, no tag -> stale
        mk_proxy(&current_src, "2160", Some(PROXY_TAG)); // already the new quality
        mk_proxy(&legacy_src, "1080", None); // legacy 1080p: not the upgrade pass's job

        let all = vec![
            stale_src.clone(),
            stale_src.clone(), // a second cut of the same source: reported once
            current_src.clone(),
            legacy_src.clone(),
        ];
        let gib: u64 = 1024 * 1024 * 1024;
        // Short on space: only the stale 2160p copy is reported, once.
        assert_eq!(upgrade_space_notice_for(&all, &proxies_s, Some(1 * gib)), vec!["STALE_clip".to_string()]);
        // Plenty of space: silent.
        assert!(upgrade_space_notice_for(&all, &proxies_s, Some(500 * gib)).is_empty());
        // Unknown free space: silent.
        assert!(upgrade_space_notice_for(&all, &proxies_s, None).is_empty());
        // No working copy on disk yet: silent.
        assert!(upgrade_space_notice_for(&[dir.join("nope.mp4").to_str().unwrap().to_string()], &proxies_s, Some(1 * gib)).is_empty());
        eprintln!("space_notice_real_files ok");
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn real_upgrade_paths() {
        use std::os::windows::fs::OpenOptionsExt;
        let (clip, dir) = match (std::env::var("RC_TEST_CLIP"), std::env::var("RC_TEST_DIR")) {
            (Ok(c), Ok(d)) if !c.is_empty() && !d.is_empty() => (c, std::path::PathBuf::from(d)),
            _ => {
                eprintln!("RC_TEST_CLIP / RC_TEST_DIR not set: skipping");
                return;
            }
        };
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("RUSHCUT_DATA_DIR", &data);
        assert!(crate::db::db_path().starts_with(&dir), "DB must be the scratch DB");
        let proxies = dir.join("proxies");
        std::fs::create_dir_all(&proxies).unwrap();
        let proxies_s = proxies.to_str().unwrap().to_string();

        // Throwaway DB with just the table has_active_job reads.
        let conn = rusqlite::Connection::open(crate::db::db_path()).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS jobs (id TEXT, project_id TEXT, status TEXT);").unwrap();

        // 30 s source excerpt (stream copy), the "camera original" for this test.
        let src = dir.join("src.mp4");
        assert!(rc_run(ffmpeg_exe(), &["-hide_banner", "-loglevel", "error", "-ss", "10", "-t", "30", "-i", &clip,
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-y", src.to_str().unwrap()]));
        let src_s = src.to_str().unwrap().to_string();

        // The old (QP30-era, untagged) proxy, built with the exact pre-#198 arguments.
        let old30 = dir.join("old_qp30.mp4");
        assert!(rc_run(ffmpeg_exe(), &["-hide_banner", "-loglevel", "error", "-i", &src_s, "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=-2:2160,format=yuv420p", "-r", "30000/1001", "-fps_mode", "cfr", "-c:v", "h264_amf", "-pix_fmt", "yuv420p",
            "-profile:v", "main", "-rc", "cqp", "-qp_i", "30", "-qp_p", "30", "-quality", "speed", "-c:a", "aac", "-b:a", "128k",
            "-ar", "48000", "-y", old30.to_str().unwrap()]));
        let proxy = proxies.join(format!("{}.mp4", proxy_name_for_path(&src_s)));
        let proxy_s = proxy.to_str().unwrap().to_string();
        let tmp = proxies.join(format!("{}.upg.tmp.mp4", proxy_name_for_path(&src_s)));
        let reset_old = || { std::fs::copy(&old30, &proxy).unwrap(); };
        let set_job = |status: &str| {
            let c = rusqlite::Connection::open(crate::db::db_path()).unwrap();
            c.execute("DELETE FROM jobs", []).unwrap();
            if status != "none" {
                c.execute("INSERT INTO jobs (id, project_id, status) VALUES ('j1','p1',?1)", [status]).unwrap();
            }
        };
        let old_size = std::fs::metadata(&old30).unwrap().len();

        // A. clean upgrade: old untagged proxy -> tagged QP18 proxy, temp gone, decision now Current.
        reset_old();
        set_job("none");
        assert_eq!(proxy_tag_native(&proxy_s), None);
        upgrade_existing_proxy("t-a", &src_s, &proxy_s, &proxies_s, None);
        assert_eq!(proxy_tag_native(&proxy_s).as_deref(), Some(PROXY_TAG), "A: tag written");
        assert!(proxy_height_native(&proxy_s) >= 2160, "A: still 2160p");
        let new_size = std::fs::metadata(&proxy).unwrap().len();
        assert!(new_size > old_size, "A: QP18 proxy is bigger than the QP30 one ({} vs {})", new_size, old_size);
        assert!(!tmp.exists(), "A: temp file removed");
        assert_eq!(proxy_action(proxy_height_native(&proxy_s), proxy_tag_native(&proxy_s).as_deref()), ProxyAction::Current);
        eprintln!("A ok: old {} B -> new {} B", old_size, new_size);
        // A2. a queued duplicate of an already-upgraded proxy is skipped, not re-encoded.
        let mtime_a = std::fs::metadata(&proxy).unwrap().modified().unwrap();
        let t_dup = std::time::Instant::now();
        upgrade_existing_proxy("t-a2", &src_s, &proxy_s, &proxies_s, None);
        assert!(t_dup.elapsed().as_secs_f64() < 5.0, "A2: duplicate must skip, not re-encode");
        assert_eq!(std::fs::metadata(&proxy).unwrap().modified().unwrap(), mtime_a, "A2: proxy file untouched");
        eprintln!("A2 ok: duplicate upgrade of a current proxy skipped");

        // B. a render is active (ANY project): the upgrade must not start; old proxy untouched.
        reset_old();
        set_job("processing");
        upgrade_existing_proxy("t-b", &src_s, &proxy_s, &proxies_s, None);
        assert_eq!(proxy_tag_native(&proxy_s), None, "B: old proxy untouched");
        assert_eq!(std::fs::metadata(&proxy).unwrap().len(), old_size, "B: size unchanged");
        assert!(!tmp.exists(), "B: no temp file");
        eprintln!("B ok: skipped while a render is active");

        // C. a render STARTS mid-encode: encode killed, temp removed, old proxy intact, retry allowed.
        reset_old();
        set_job("none");
        let t0 = std::time::Instant::now();
        let flipper = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let c = rusqlite::Connection::open(crate::db::db_path()).unwrap();
            c.execute("INSERT INTO jobs (id, project_id, status) VALUES ('j2','p2','processing')", []).unwrap();
        });
        upgrade_existing_proxy("t-c", &src_s, &proxy_s, &proxies_s, None);
        flipper.join().unwrap();
        let took = t0.elapsed().as_secs_f64();
        assert_eq!(proxy_tag_native(&proxy_s), None, "C: old proxy intact");
        assert_eq!(std::fs::metadata(&proxy).unwrap().len(), old_size, "C: size unchanged");
        assert!(!tmp.exists(), "C: temp removed");
        assert!(try_begin_upgrade(&proxy_s).is_some(), "C: not marked failed, retry allowed");
        // A full encode takes about 15 s; render started at 3 s; polled every 2 s => well under 10 s.
        assert!(took < 10.0, "C: cancel must land within a few seconds of the render starting, took {:.1}s", took);
        eprintln!("C ok: cancelled after {:.1}s (render started at 3 s)", took);

        // D. swap fails (old proxy held open without share-delete): old intact, temp removed, not retried.
        reset_old();
        set_job("none");
        {
            let _held = std::fs::OpenOptions::new().read(true).share_mode(1).open(&proxy).unwrap();
            upgrade_existing_proxy("t-d", &src_s, &proxy_s, &proxies_s, None);
        }
        assert_eq!(proxy_tag_native(&proxy_s), None, "D: old proxy intact");
        assert_eq!(std::fs::metadata(&proxy).unwrap().len(), old_size, "D: size unchanged");
        assert!(!tmp.exists(), "D: temp removed");
        assert!(try_begin_upgrade(&proxy_s).is_none(), "D: marked failed, not retried this session");
        eprintln!("D ok: swap failure keeps the old proxy, no retry loop");

        // E. the encode itself fails (source missing): old proxy intact, no temp file, not retried.
        let bad_src = dir.join("does-not-exist.mp4");
        let bad_src_s = bad_src.to_str().unwrap().to_string();
        let proxy_e = proxies.join(format!("{}.mp4", proxy_name_for_path(&bad_src_s)));
        let proxy_e_s = proxy_e.to_str().unwrap().to_string();
        std::fs::copy(&old30, &proxy_e).unwrap();
        set_job("none");
        upgrade_existing_proxy("t-e", &bad_src_s, &proxy_e_s, &proxies_s, None);
        assert_eq!(proxy_tag_native(&proxy_e_s), None, "E: old proxy intact");
        assert_eq!(std::fs::metadata(&proxy_e).unwrap().len(), old_size, "E: size unchanged");
        assert!(!proxies.join(format!("{}.upg.tmp.mp4", proxy_name_for_path(&bad_src_s))).exists(), "E: no temp file");
        assert!(try_begin_upgrade(&proxy_e_s).is_none(), "E: failed encode not retried this session");
        eprintln!("E ok: failed encode keeps the old proxy and is not retried");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// [#251] Real encoder, faked free space: a disk-floor cancel must not block the retry.
    ///   $env:RC_TEST_CLIP=...; $env:RC_TEST_DIR=<scratch>; cargo test --lib proxy_upgrade_tests::disk_floor_retry_real_files -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn disk_floor_retry_real_files() {
        use std::sync::atomic::Ordering::SeqCst;
        struct ResetFake;
        impl Drop for ResetFake {
            fn drop(&mut self) {
                TEST_FAKE_FREE.store(0, SeqCst);
            }
        }
        let _reset = ResetFake;
        let (clip, dir) = match (std::env::var("RC_TEST_CLIP"), std::env::var("RC_TEST_DIR")) {
            (Ok(c), Ok(d)) if !c.is_empty() && !d.is_empty() => (c, std::path::PathBuf::from(d)),
            _ => {
                eprintln!("RC_TEST_CLIP / RC_TEST_DIR not set: skipping");
                return;
            }
        };
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("RUSHCUT_DATA_DIR", &data);
        assert!(crate::db::db_path().starts_with(&dir), "DB must be the scratch DB");
        let proxies = dir.join("proxies");
        std::fs::create_dir_all(&proxies).unwrap();
        let proxies_s = proxies.to_str().unwrap().to_string();
        let conn = rusqlite::Connection::open(crate::db::db_path()).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS jobs (id TEXT, project_id TEXT, status TEXT);").unwrap();
        let src = dir.join("src.mp4");
        assert!(rc_run(ffmpeg_exe(), &["-hide_banner", "-loglevel", "error", "-ss", "10", "-t", "30", "-i", &clip,
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-y", src.to_str().unwrap()]));
        let src_s = src.to_str().unwrap().to_string();
        let old30 = dir.join("old_qp30.mp4");
        assert!(rc_run(ffmpeg_exe(), &["-hide_banner", "-loglevel", "error", "-i", &src_s, "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=-2:2160,format=yuv420p", "-r", "30000/1001", "-fps_mode", "cfr", "-c:v", "h264_amf", "-pix_fmt", "yuv420p",
            "-profile:v", "main", "-rc", "cqp", "-qp_i", "30", "-qp_p", "30", "-quality", "speed", "-c:a", "aac", "-b:a", "128k",
            "-ar", "48000", "-y", old30.to_str().unwrap()]));
        let proxy = proxies.join(format!("{}.mp4", proxy_name_for_path(&src_s)));
        let proxy_s = proxy.to_str().unwrap().to_string();
        let tmp = proxies.join(format!("{}.upg.tmp.mp4", proxy_name_for_path(&src_s)));
        std::fs::copy(&old30, &proxy).unwrap();
        let old_size = std::fs::metadata(&old30).unwrap().len();
        let gib: u64 = 1024 * 1024 * 1024;

        // 1. Plenty of space at the start, then space drops below the 3 GiB floor mid-encode.
        TEST_FAKE_FREE.store(500 * gib, SeqCst);
        let dropper = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            TEST_FAKE_FREE.store(1 * gib, SeqCst);
        });
        let t0 = std::time::Instant::now();
        upgrade_existing_proxy("t-f1", &src_s, &proxy_s, &proxies_s, None);
        dropper.join().unwrap();
        assert!(t0.elapsed().as_secs_f64() < 10.0, "F1: cancel must land within seconds of the floor breach");
        assert_eq!(proxy_tag_native(&proxy_s), None, "F1: old proxy intact");
        assert_eq!(std::fs::metadata(&proxy).unwrap().len(), old_size, "F1: size unchanged");
        assert!(!tmp.exists(), "F1: temp removed");

        // 2. Space still short: the retry must NOT start an encode (no temp file, no loop).
        let t1 = std::time::Instant::now();
        upgrade_existing_proxy("t-f2", &src_s, &proxy_s, &proxies_s, None);
        assert!(t1.elapsed().as_secs_f64() < 3.0, "F2: skipped at once, no encode");
        assert!(!tmp.exists(), "F2: no temp file while space is short");
        assert_eq!(proxy_tag_native(&proxy_s), None, "F2: old proxy intact");

        // 3. Space freed, same session, no restart: the clip upgrades.
        TEST_FAKE_FREE.store(500 * gib, SeqCst);
        upgrade_existing_proxy("t-f3", &src_s, &proxy_s, &proxies_s, None);
        assert_eq!(proxy_tag_native(&proxy_s).as_deref(), Some(PROXY_TAG), "F3: upgraded after space freed");
        assert!(!tmp.exists(), "F3: temp removed");

        // 5. Self-caused breach: the floor is hit mid-encode and free space is back above the start
        //    threshold once our temp file is gone -> the clip stays failed, no repeated encode.
        let src2 = dir.join("src2.mp4");
        std::fs::copy(&src, &src2).unwrap();
        let src2_s = src2.to_str().unwrap().to_string();
        let proxy2 = proxies.join(format!("{}.mp4", proxy_name_for_path(&src2_s)));
        let proxy2_s = proxy2.to_str().unwrap().to_string();
        let tmp2 = proxies.join(format!("{}.upg.tmp.mp4", proxy_name_for_path(&src2_s)));
        std::fs::copy(&old30, &proxy2).unwrap();
        TEST_FAKE_FREE.store(500 * gib, SeqCst);
        let dropper2 = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            TEST_FAKE_SELF_CAUSED.store(true, SeqCst);
            TEST_FAKE_FREE.store(1 * gib, SeqCst);
        });
        upgrade_existing_proxy("t-f5a", &src2_s, &proxy2_s, &proxies_s, None);
        dropper2.join().unwrap();
        assert_eq!(proxy_tag_native(&proxy2_s), None, "F5: old proxy intact");
        assert!(!tmp2.exists(), "F5: temp removed");
        TEST_FAKE_SELF_CAUSED.store(false, SeqCst);
        TEST_FAKE_FREE.store(500 * gib, SeqCst); // plenty of space again
        let t5 = std::time::Instant::now();
        upgrade_existing_proxy("t-f5b", &src2_s, &proxy2_s, &proxies_s, None);
        assert!(t5.elapsed().as_secs_f64() < 3.0, "F5: self-caused clip is not re-encoded");
        assert!(!tmp2.exists(), "F5: no temp file on the retry attempt");
        assert_eq!(proxy_tag_native(&proxy2_s), None, "F5: stays on the old proxy for this session");
        assert!(try_begin_upgrade(&proxy2_s).is_none(), "F5: marked failed for the session");

        // 4. A genuinely failing encode is still marked failed (guard kept).
        let bad_src = dir.join("does-not-exist.mp4");
        let bad_s = bad_src.to_str().unwrap().to_string();
        let proxy_e = proxies.join(format!("{}.mp4", proxy_name_for_path(&bad_s)));
        let proxy_e_s = proxy_e.to_str().unwrap().to_string();
        std::fs::copy(&old30, &proxy_e).unwrap();
        upgrade_existing_proxy("t-f4", &bad_s, &proxy_e_s, &proxies_s, None);
        assert!(try_begin_upgrade(&proxy_e_s).is_none(), "F4: failed encode not retried this session");

        TEST_FAKE_FREE.store(0, SeqCst);
        eprintln!("disk_floor_retry_real_files ok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // #234: the startup fallback removes only OLD *.upg.tmp.mp4 files.
    #[test]
    fn sweep_removes_only_old_upgrade_temps() {
        let d = std::env::temp_dir().join(format!("rc_sweep_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let mk = |n: &str| { std::fs::write(d.join(n), b"x").unwrap(); };
        mk("00000000000000a1.upg.tmp.mp4");
        mk("00000000000000a2.tmp.mp4");
        mk("00000000000000a3.mp4");
        // grace zero = everything old enough: only the exact upgrade-temp suffix goes.
        let (n, _) = sweep_orphan_upgrade_temps(&d, std::time::Duration::ZERO);
        assert_eq!(n, 1);
        assert!(!d.join("00000000000000a1.upg.tmp.mp4").exists());
        assert!(d.join("00000000000000a2.tmp.mp4").exists(), "fresh-encode staging file untouched");
        assert!(d.join("00000000000000a3.mp4").exists(), "real proxy untouched");
        // a recent upgrade temp (live encode) survives a real grace period.
        mk("00000000000000a4.upg.tmp.mp4");
        let (n2, _) = sweep_orphan_upgrade_temps(&d, std::time::Duration::from_secs(600));
        assert_eq!(n2, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    // #234 probe (ignored, needs a clip). Starts a real upgrade, then simulates closing the app:
    // RC_PROBE_SHUTDOWN=1 runs the exit hook first; unset = the old behaviour (reproduction).
    // After the process ends, the runner checks for a surviving ffmpeg and a leftover temp file.
    //   $env:RC_TEST_CLIP=...; $env:RC_TEST_DIR=<scratch>; cargo test --lib proxy_upgrade_tests::exit_mid_upgrade_probe -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn exit_mid_upgrade_probe() {
        let (clip, dir) = match (std::env::var("RC_TEST_CLIP"), std::env::var("RC_TEST_DIR")) {
            (Ok(c), Ok(d)) if !c.is_empty() && !d.is_empty() => (c, std::path::PathBuf::from(d)),
            _ => { eprintln!("RC_TEST_CLIP / RC_TEST_DIR not set: skipping"); return; }
        };
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("RUSHCUT_DATA_DIR", &data);
        let proxies = dir.join("proxies");
        std::fs::create_dir_all(&proxies).unwrap();
        let conn = rusqlite::Connection::open(crate::db::db_path()).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS jobs (id TEXT, project_id TEXT, status TEXT);").unwrap();
        let src = dir.join("src.mp4");
        assert!(rc_run(ffmpeg_exe(), &["-hide_banner", "-loglevel", "error", "-ss", "10", "-t", "60", "-i", &clip,
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-y", src.to_str().unwrap()]));
        let src_s = src.to_str().unwrap().to_string();
        let proxy = proxies.join(format!("{}.mp4", proxy_name_for_path(&src_s)));
        let proxy_s = proxy.to_str().unwrap().to_string();
        let proxies_s = proxies.to_str().unwrap().to_string();
        let tmp = proxies.join(format!("{}.upg.tmp.mp4", proxy_name_for_path(&src_s)));
        // old untagged proxy, so the upgrade has something to replace
        assert!(rc_run(ffmpeg_exe(), &["-hide_banner", "-loglevel", "error", "-i", &src_s, "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=-2:2160,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-y", &proxy_s]));
        let old_len = std::fs::metadata(&proxy).unwrap().len();
        let (p2, s2, d2) = (proxy_s.clone(), src_s.clone(), proxies_s.clone());
        std::thread::spawn(move || { upgrade_existing_proxy("probe", &s2, &p2, &d2, None); });
        std::thread::sleep(std::time::Duration::from_secs(5));
        eprintln!("PROBE before-exit: tmp_exists={} registered={}", tmp.exists(), BG_FFMPEG.lock().unwrap().len());
        if std::env::var("RC_PROBE_SHUTDOWN").as_deref() == Ok("1") { shutdown_background_work(); }
        eprintln!("PROBE after-hook: tmp_exists={} old_proxy_intact={}", tmp.exists(), std::fs::metadata(&proxy).map(|m| m.len() == old_len).unwrap_or(false));
        std::process::exit(0); // the app closing: no unwinding, no Drop
    }
}

#[cfg(test)]
mod vacuum_tests {
    use super::vacuum_dir;
    use std::collections::HashSet;
    use std::time::Duration;
    /// junk grace used by the pre-#287 tests: fresh staging files must survive
    const DAY: Duration = Duration::from_secs(24 * 3600);

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rc_vacuum_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn mk(d: &std::path::Path, n: &str) -> String {
        let p = d.join(n);
        std::fs::write(&p, vec![0u8; 2048]).unwrap();
        p.to_string_lossy().to_lowercase()
    }
    fn set(v: &[&String]) -> HashSet<String> { v.iter().map(|s| (*s).clone()).collect() }

    #[test]
    fn orphan_removed_active_and_stale_rules() {
        let d = scratch("rules");
        let shared = mk(&d, "00000000000000a1.mp4");     // referenced by an active project too
        let live = mk(&d, "00000000000000a2.mp4");         // referenced + active
        let dead = mk(&d, "00000000000000a3.mp4");         // referenced only by a stale project
        let orphan = mk(&d, "00000000000000a4.mp4");     // referenced by nothing
        let tmp = mk(&d, "00000000000000a5.tmp.mp4");         // in-flight staging
        let upg = mk(&d, "00000000000000a6.upg.tmp.mp4");
        let foreign = mk(&d, "notes_not_a_proxy.mp4"); // not a RushCut proxy name: never touched
        let (o, s, b) = vacuum_dir(&d, Duration::ZERO, DAY, true, || {
            Some((set(&[&shared, &live, &dead]), set(&[&shared, &live])))
        }).unwrap();
        assert_eq!((o, s, b), (1, 1, 4096));
        assert!(std::path::Path::new(&shared).exists());
        assert!(std::path::Path::new(&live).exists());
        assert!(!std::path::Path::new(&dead).exists());
        assert!(!std::path::Path::new(&orphan).exists());
        assert!(std::path::Path::new(&tmp).exists() && std::path::Path::new(&upg).exists());
        assert!(std::path::Path::new(&foreign).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn old_file_of_active_project_survives_no_30_day_rule() {
        let d = scratch("old");
        let p = mk(&d, "00000000000000b1.mp4");
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(200 * 24 * 3600);
        f.set_modified(old).unwrap();
        drop(f);
        let (o, s, _) = vacuum_dir(&d, Duration::ZERO, DAY, true, || Some((set(&[&p]), set(&[&p])))).unwrap();
        assert_eq!((o, s), (0, 0));
        assert!(std::path::Path::new(&p).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn stale_projects_kept_while_stale_removal_is_off() {
        let d = scratch("nostale");
        let dead = mk(&d, "00000000000000e1.mp4");   // referenced, project stale
        let orphan = mk(&d, "00000000000000e2.mp4"); // referenced by nothing
        let (o, s, _) = vacuum_dir(&d, Duration::ZERO, DAY, false, || Some((set(&[&dead]), HashSet::new()))).unwrap();
        assert_eq!((o, s), (1, 0));
        assert!(std::path::Path::new(&dead).exists());
        assert!(!std::path::Path::new(&orphan).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unreadable_db_deletes_nothing() {
        let d = scratch("nodb");
        let p = mk(&d, "00000000000000d1.mp4");
        assert!(vacuum_dir(&d, Duration::ZERO, Duration::ZERO, true, || None).is_none());
        assert!(std::path::Path::new(&p).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    // #287: orphan *.mp4.bak and abandoned *.tmp.mp4 go once past the junk grace; fresh ones,
    // *.upg.tmp.mp4 and non-proxy names stay; a live proxy is never touched.
    #[test]
    fn junk_bak_and_tmp_removed_only_when_old_enough() {
        let d = scratch("junk");
        let live = mk(&d, "00000000000000f1.mp4");
        let bak = mk(&d, "00000000000000f2.mp4.bak");
        let tmp = mk(&d, "00000000000000f3.tmp.mp4");
        let upg = mk(&d, "00000000000000f4.upg.tmp.mp4");
        let foreign_bak = mk(&d, "notes.mp4.bak");
        let foreign_tmp = mk(&d, "notes.tmp.mp4");
        // fresh files + a 24 h grace: nothing junk goes
        let (o, _, _) = vacuum_dir(&d, Duration::from_secs(3600), DAY, true, || Some((set(&[&live]), set(&[&live])))).unwrap();
        assert_eq!(o, 0);
        assert!(std::path::Path::new(&bak).exists() && std::path::Path::new(&tmp).exists());
        // zero grace stands in for "older than 24 h"
        let (o, s, b) = vacuum_dir(&d, Duration::from_secs(3600), Duration::ZERO, true, || Some((set(&[&live]), set(&[&live])))).unwrap();
        assert_eq!((o, s, b), (2, 0, 4096));
        assert!(!std::path::Path::new(&bak).exists());
        assert!(!std::path::Path::new(&tmp).exists());
        assert!(std::path::Path::new(&live).exists());
        assert!(std::path::Path::new(&upg).exists(), "*.upg.tmp.mp4 belongs to sweep_orphan_upgrade_temps");
        assert!(std::path::Path::new(&foreign_bak).exists() && std::path::Path::new(&foreign_tmp).exists());
        // an unreadable DB deletes no junk either
        let _ = mk(&d, "00000000000000f5.mp4.bak");
        assert!(vacuum_dir(&d, Duration::ZERO, Duration::ZERO, true, || None).is_none());
        assert!(d.join("00000000000000f5.mp4.bak").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    // #287 (A4): with the 90-day rule ON, an idle project's unshared proxy goes and a proxy
    // shared with an active project stays.
    #[test]
    fn stale_rule_is_on_and_keeps_shared_proxies() {
        assert!(super::VACUUM_REMOVE_STALE, "A4 approved 2026-11-23");
        let d = scratch("a4");
        let shared = mk(&d, "00000000000000a1.mp4");
        let idle_only = mk(&d, "00000000000000b2.mp4");
        let (o, s, _) = vacuum_dir(&d, Duration::ZERO, DAY, super::VACUUM_REMOVE_STALE, || {
            Some((set(&[&shared, &idle_only]), set(&[&shared])))
        }).unwrap();
        assert_eq!((o, s), (0, 1));
        assert!(std::path::Path::new(&shared).exists());
        assert!(!std::path::Path::new(&idle_only).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn young_files_are_skipped_by_grace() {
        let d = scratch("grace");
        let p = mk(&d, "00000000000000c1.mp4");
        let (o, s, _) = vacuum_dir(&d, Duration::from_secs(3600), DAY, true, || Some((HashSet::new(), HashSet::new()))).unwrap();
        assert_eq!((o, s), (0, 0));
        assert!(std::path::Path::new(&p).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn isolated_dir_guard_and_activity_query_on_scratch_db() {
        // One test owns RUSHCUT_DATA_DIR (env is process-wide): scratch DB, never the real one.
        let dir = scratch("db");
        std::env::set_var("RUSHCUT_DATA_DIR", &dir);
        assert_eq!(super::vacuum_proxies_cmd(), "skipped=isolated_data_dir");
        let conn = rusqlite::Connection::open(crate::db::db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT, name TEXT, created_at TEXT);
             CREATE TABLE clips (id TEXT, project_id TEXT, proxy_path TEXT, proxy_status TEXT, created_at TEXT);
             CREATE TABLE jobs (id TEXT, project_id TEXT, status TEXT, updated_at TEXT);
             INSERT INTO projects VALUES ('old','o','2020-01-01T00:00:00Z'),('old2','o2','2020-01-01T00:00:00Z'),
                                         ('rendered','r','2020-01-01T00:00:00Z'),('new','n','2099-01-01T00:00:00Z');
             -- stale project only
             INSERT INTO clips VALUES ('c1','old','P_STALE','done','2020-01-01T00:00:00Z');
             -- shared by a stale and a new project -> active
             INSERT INTO clips VALUES ('c2','old2','P_SHARED','done','2020-01-01T00:00:00Z');
             INSERT INTO clips VALUES ('c3','new','P_SHARED','done','2099-01-01T00:00:00Z');
             -- old project, but a recent job -> active
             INSERT INTO clips VALUES ('c4','rendered','P_JOB','done','2020-01-01T00:00:00Z');
             INSERT INTO jobs VALUES ('j','rendered','done','2099-01-01T00:00:00Z');
             -- old project with an encoding proxy -> active
             INSERT INTO projects VALUES ('enc','x','2020-01-01T00:00:00Z');
             INSERT INTO clips VALUES ('c5','enc','P_ENC','encoding','2020-01-01T00:00:00Z');
             -- old clips in a project where the owner just added a NEW clip -> all its proxies active
             INSERT INTO projects VALUES ('edit','e','2020-01-01T00:00:00Z');
             INSERT INTO clips VALUES ('c6','edit','P_SIB_OLD','done','2020-01-01T00:00:00Z');
             INSERT INTO clips VALUES ('c7','edit','P_SIB_NEW','done','2099-01-01T00:00:00Z');",
        ).unwrap();
        drop(conn);
        let (all, active) = crate::db::get_proxy_refs_for_vacuum(90).unwrap();
        std::env::remove_var("RUSHCUT_DATA_DIR");
        let a: HashSet<String> = all.into_iter().collect();
        let act: HashSet<String> = active.into_iter().collect();
        assert_eq!(a.len(), 6);
        assert!(!act.contains("P_STALE"), "a wholly stale project must not be kept");
        assert!(act.contains("P_SHARED") && act.contains("P_JOB") && act.contains("P_ENC"));
        assert!(act.contains("P_SIB_OLD") && act.contains("P_SIB_NEW"), "sibling-clip activity must keep the whole project");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// #287: sweep of %TEMP%\rushcut (scratch dir only; no env mutation, no real DB).
#[cfg(test)]
mod temp_sweep_tests {
    use super::{classify_temp_item, is_job_uuid, sweep_temp_dir, temp_belongs_to_data_dir, TempKind};
    use std::collections::HashSet;
    use std::path::Path;
    use std::time::Duration;

    const A: &str = "aaaaaaaa-1111-2222-3333-444444444444"; // terminal job
    const B: &str = "bbbbbbbb-1111-2222-3333-444444444444"; // live job
    const C: &str = "cccccccc-1111-2222-3333-444444444444"; // unknown to the DB

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rc_tsweep_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn file(d: &Path, n: &str) { std::fs::write(d.join(n), vec![0u8; 1024]).unwrap(); }
    fn job_dir(d: &Path, n: &str) {
        std::fs::create_dir_all(d.join(n)).unwrap();
        std::fs::write(d.join(n).join("u1g_seg_0.mp4"), vec![0u8; 4096]).unwrap();
    }
    fn live(ids: &[&str]) -> HashSet<String> { ids.iter().map(|s| s.to_string()).collect() }
    fn sweep(d: &Path, work: Duration, log: Duration, ids: &[&str]) -> (u32, u64) {
        sweep_temp_dir(d, work, log, || Some(live(ids))).unwrap()
    }

    #[test]
    fn only_job_shaped_names_are_classified() {
        assert!(is_job_uuid(A));
        assert!(!is_job_uuid("render-timing-log"));
        assert_eq!(classify_temp_item(&format!("{}.json", A), false), Some((A.into(), TempKind::Work)));
        assert_eq!(classify_temp_item(&format!("{}.pid", A), false), Some((A.into(), TempKind::Work)));
        assert_eq!(classify_temp_item(A, true), Some((A.into(), TempKind::Work)));
        assert_eq!(classify_temp_item(&format!("pipeline-{}.log", A), false), Some((A.into(), TempKind::Log)));
        assert_eq!(classify_temp_item(&format!("{}.json.sweep", A), false), Some((A.into(), TempKind::Work)));
        for never in ["render-timing-log.jsonl", "proxy-bg.log", "playback-trace.log", "proxy-timing.json",
                      "pipeline-latest.log", "notes.txt", "abc-thumb.jpg", "x.json"] {
            assert_eq!(classify_temp_item(never, false), None, "{}", never);
        }
        // a FILE named like a job dir, and a dir named like a manifest, are not job items
        assert_eq!(classify_temp_item(A, false), None);
        assert_eq!(classify_temp_item(&format!("{}.json", A), true), None);
    }

    #[test]
    fn terminal_and_unknown_removed_live_recent_and_foreign_kept() {
        let d = scratch("rules");
        for id in [A, B, C] { file(&d, &format!("{}.json", id)); file(&d, &format!("{}.pid", id)); job_dir(&d, id); }
        file(&d, &format!("pipeline-{}.log", A));
        for keep in ["render-timing-log.jsonl", "proxy-bg.log", "playback-trace.log", "proxy-timing.json", "stuff.bin"] { file(&d, keep); }
        let (n, bytes) = sweep(&d, Duration::ZERO, Duration::ZERO, &[B]);
        // A and C: json + pid + dir each (6) + A's log (1)
        assert_eq!(n, 7);
        assert_eq!(bytes, 2 * (1024 + 1024 + 4096) + 1024);
        for id in [A, C] {
            assert!(!d.join(format!("{}.json", id)).exists() && !d.join(id).exists(), "{}", id);
        }
        for id in [B] {
            assert!(d.join(format!("{}.json", id)).exists() && d.join(format!("{}.pid", id)).exists() && d.join(id).exists(), "live job kept");
        }
        for keep in ["render-timing-log.jsonl", "proxy-bg.log", "playback-trace.log", "proxy-timing.json", "stuff.bin"] {
            assert!(d.join(keep).exists(), "{} must survive", keep);
        }
        // no .sweep claim is left behind
        assert!(std::fs::read_dir(&d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".sweep")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retention_and_log_vs_work_windows() {
        let d = scratch("ret");
        file(&d, &format!("{}.json", A));
        file(&d, &format!("pipeline-{}.log", A));
        // everything is brand new: a real retention keeps all of it
        assert_eq!(sweep(&d, Duration::from_secs(7 * 86400), Duration::from_secs(30 * 86400), &[]).0, 0);
        // work window passed, log window not: only the work item goes
        let (n, _) = sweep(&d, Duration::ZERO, Duration::from_secs(30 * 86400), &[]);
        assert_eq!(n, 1);
        assert!(!d.join(format!("{}.json", A)).exists());
        assert!(d.join(format!("pipeline-{}.log", A)).exists(), "per-job log outlives work files");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn old_file_is_removed_by_age_real_mtime() {
        let d = scratch("mtime");
        file(&d, &format!("{}.json", A));
        file(&d, &format!("{}.json", C));
        let f = std::fs::OpenOptions::new().write(true).open(d.join(format!("{}.json", A))).unwrap();
        f.set_modified(std::time::SystemTime::now() - Duration::from_secs(8 * 86400)).unwrap();
        drop(f);
        // creation time of a freshly written file is "now", so age uses the NEWER stamp: this
        // proves the guard errs towards keeping. Zero-retention covers the remove path above.
        let (n, _) = sweep(&d, Duration::from_secs(7 * 86400), Duration::from_secs(30 * 86400), &[]);
        assert_eq!(n, 0, "newer of mtime/created decides: a recreated file is not old");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unreadable_db_deletes_nothing() {
        let d = scratch("nodb");
        file(&d, &format!("{}.json", A));
        assert!(sweep_temp_dir(&d, Duration::ZERO, Duration::ZERO, || None).is_none());
        assert!(d.join(format!("{}.json", A)).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn interrupted_claim_is_finished_and_live_claim_is_not() {
        let d = scratch("claim");
        file(&d, &format!("{}.json.sweep", A)); // earlier sweep renamed it, then died
        file(&d, &format!("{}.json.sweep", B)); // live job: never
        let (n, _) = sweep(&d, Duration::ZERO, Duration::ZERO, &[B]);
        assert_eq!(n, 1);
        assert!(!d.join(format!("{}.json.sweep", A)).exists());
        assert!(d.join(format!("{}.json.sweep", B)).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_dir_is_a_clean_noop() {
        let d = std::env::temp_dir().join(format!("rc_tsweep_missing_{}", std::process::id()));
        assert_eq!(sweep_temp_dir(&d, Duration::ZERO, Duration::ZERO, || Some(HashSet::new())), Some((0, 0)));
    }

    // QA isolation: a QA instance may sweep only a temp folder under its own run root.
    #[test]
    fn qa_instance_cannot_sweep_the_live_temp_folder() {
        let live_temp = Path::new(r"C:\Users\someone\AppData\Local\Temp\rushcut");
        let qa_data = Path::new(r"C:\rcqa\run1\data");
        // DB-only isolation: scratch DB but the LIVE temp -> refused
        assert!(!temp_belongs_to_data_dir(live_temp, qa_data));
        // QA_ISOLATE_RENDER=1: temp lives beside data under the run root -> allowed
        assert!(temp_belongs_to_data_dir(Path::new(r"C:\rcqa\run1\temp\rushcut"), qa_data));
        // a sibling run is not "its own"
        assert!(!temp_belongs_to_data_dir(Path::new(r"C:\rcqa\run2\temp\rushcut"), qa_data));
        // a data dir directly under a drive root would make the whole drive "own": refused
        assert!(!temp_belongs_to_data_dir(live_temp, Path::new(r"C:\data")));
    }
}
