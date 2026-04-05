mod db;

use db::{
    delete_project, get_job, get_project_with_clips, insert_clip, insert_job, insert_project,
    list_projects, rename_project, reorder_clips, update_clip_proxy, update_clip_review,
    update_job_analysis, update_job_done, update_job_error, update_job_progress, Clip, ClipMeta,
    Job, ProjectSummary, ProjectWithClips,
};
use serde_json::json;
use std::io::{BufRead, BufReader};
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
/// e.g. C:\clips\foo.mp4 -> /mnt/c/clips/foo.mp4
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
// Tauri commands
// ---------------------------------------------------------------------------

/// Scan a folder for video clips via pipeline/scan.py.
/// folder_path: Windows path (e.g. C:\clips\)
/// Returns array of ClipMeta with Windows local_path values.
#[tauri::command]
fn scan_folder(folder_path: String) -> Result<Vec<ClipMeta>, String> {
    let wsl_folder = win_to_wsl(&folder_path);

    let output = std::process::Command::new("wsl")
        .args([
            "-d", "Ubuntu-24.04",
            "-u", "root",
            "--",
            "python3",
            "/mnt/c/apps/rushcut/pipeline/scan.py",
            "--folder",
            &wsl_folder,
        ])
        .output()
        .map_err(|e| format!("Failed to launch scan.py: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("scan.py failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let clips: Vec<ClipMeta> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse scan.py output: {}\n{}", e, stdout))?;

    Ok(clips)
}

/// Delete a project and all associated clips and jobs.
#[tauri::command]
fn delete_project_cmd(project_id: String) -> Result<(), String> {
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

/// Probe a list of individual video files (Windows paths) via scan.py --files.
/// Returns ClipMeta for each valid video file.
#[tauri::command]
fn probe_files(paths: Vec<String>) -> Result<Vec<ClipMeta>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }

    let wsl_paths: Vec<String> = paths.iter().map(|p| win_to_wsl(p)).collect();

    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["-d", "Ubuntu-24.04", "-u", "root", "--", "python3",
              "/mnt/c/apps/rushcut/pipeline/scan.py", "--files"]);
    for wp in &wsl_paths {
        cmd.arg(wp);
    }

    let output = cmd.output().map_err(|e| format!("Failed to launch scan.py: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("scan.py --files failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let clips: Vec<ClipMeta> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse scan.py output: {}\n{}", e, stdout))?;

    Ok(clips)
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
            include: 1,
            proxy_path: None,
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

/// Kick off H.264 720p proxy generation for all un-proxied clips in a project.
/// Returns immediately; proxies are written in a background WSL task.
#[tauri::command]
async fn generate_proxies_cmd(app: AppHandle, project_id: String) -> Result<(), String> {
    let project_data = get_project_with_clips(&project_id)
        .map_err(|e| format!("DB error (get clips): {}", e))?;

    // Filter to included clips that don't have a proxy yet.
    // Skipped clips (include==0) get no proxy — if user later re-includes them,
    // on-demand proxy generation (Batch 14a) will handle it.
    let pending: Vec<_> = project_data
        .clips
        .iter()
        .filter(|c| c.include != 0 && c.proxy_path.is_none())
        .collect();

    if pending.is_empty() {
        return Ok(());
    }

    // Proxy storage: %APPDATA%\rushcut\proxies
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA env var not set".to_string())?;
    let proxy_win_dir = format!(r"{}\rushcut\proxies", appdata);
    std::fs::create_dir_all(&proxy_win_dir)
        .map_err(|e| format!("Failed to create proxy dir: {}", e))?;
    let proxy_wsl_dir = win_to_wsl(&proxy_win_dir);

    // Write proxy manifest to %TEMP%\rushcut\<project_id>-proxy.json
    let manifest = serde_json::json!({
        "project_id": project_id,
        "proxy_dir": proxy_wsl_dir,
        "clips": pending.iter().map(|c| serde_json::json!({
            "id": c.id,
            "local_path": c.local_path,
        })).collect::<Vec<_>>(),
    });
    let temp_dir = std::env::temp_dir().join("rushcut");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let manifest_path = temp_dir.join(format!("{}-proxy.json", project_id));
    std::fs::write(&manifest_path, manifest.to_string())
        .map_err(|e| format!("Failed to write proxy manifest: {}", e))?;
    let wsl_manifest = win_to_wsl(&manifest_path.to_string_lossy());

    tauri::async_runtime::spawn(async move {
        run_proxy_gen(app, project_id, wsl_manifest).await;
    });

    Ok(())
}

async fn run_proxy_gen(app: AppHandle, project_id: String, wsl_manifest_path: String) {
    let mut child = match std::process::Command::new("wsl")
        .args([
            "-d", "Ubuntu-24.04",
            "-u", "root",
            "--",
            "python3",
            "/mnt/c/apps/rushcut/pipeline/proxy.py",
            "--manifest-path", &wsl_manifest_path,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[proxy] Failed to spawn: {}", e);
            let _ = app.emit("proxy-error", json!({ "projectId": project_id, "message": e.to_string() }));
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

        if let Some(data) = line.strip_prefix("PROXY:") {
            // Parse clip_id=<id>,win_path=<path>
            let mut clip_id = "";
            let mut win_path = "";
            for part in data.split(',') {
                if let Some(v) = part.strip_prefix("clip_id=") { clip_id = v; }
                if let Some(v) = part.strip_prefix("win_path=") { win_path = v; }
            }
            if !clip_id.is_empty() && !win_path.is_empty() {
                let _ = update_clip_proxy(clip_id, win_path);
                let _ = app.emit("proxy-progress", json!({
                    "projectId": project_id,
                    "clipId": clip_id,
                    "winPath": win_path,
                }));
            }
        } else if let Some(pct_str) = line.strip_prefix("PROGRESS:") {
            let pct: i64 = pct_str.trim().parse().unwrap_or(0);
            let _ = app.emit("proxy-progress", json!({
                "projectId": project_id,
                "progress": pct,
            }));
        } else if line.starts_with("DONE:") {
            let _ = app.emit("proxy-done", json!({ "projectId": project_id }));
            return;
        } else if let Some(err_msg) = line.strip_prefix("ERROR:") {
            eprintln!("[proxy] ERROR: {}", err_msg);
            let _ = app.emit("proxy-error", json!({
                "projectId": project_id,
                "message": err_msg.trim(),
            }));
            return;
        }
    }

    // Process exited without DONE/ERROR
    let _ = child.wait();
    eprintln!("[proxy] process exited without DONE/ERROR");
    let _ = app.emit("proxy-error", json!({
        "projectId": project_id,
        "message": "Proxy process exited unexpectedly",
    }));
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
        .setup(|app| {
            db::init(app.handle())?;

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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            probe_files,
            create_project,
            rename_project_cmd,
            update_clip_review_cmd,
            reorder_clips_cmd,
            get_project,
            start_job,
            get_job_cmd,
            list_projects_cmd,
            delete_project_cmd,
            open_output_path,
            generate_proxies_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
