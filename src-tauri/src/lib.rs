mod db;

use db::{
    get_job, get_project_with_clips, insert_clip, insert_job, insert_project,
    update_job_done, update_job_error, update_job_progress, Clip, ClipMeta, Job,
    ProjectWithClips,
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
            thumbnail_data: None,
            sort_order: idx as i64,
            created_at: db::now(),
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

    // Build output path
    let output_path = format!(r"{}\{}.mp4", DEFAULT_OUTPUT_DIR, job_id);

    // Write manifest JSON to Windows TEMP
    let manifest = json!({
        "job_id": job_id,
        "clips": project_data.clips.iter().map(|c| json!({
            "id": c.id,
            "filename": c.filename,
            "local_path": c.local_path,
            "duration_ms": c.duration_ms,
            "width": c.width,
            "height": c.height,
            "has_audio": c.has_audio,
        })).collect::<Vec<_>>(),
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

        if let Some(pct_str) = line.strip_prefix("PROGRESS:") {
            let pct: i64 = pct_str.trim().parse().unwrap_or(0);
            let _ = update_job_progress(&job_id, pct, "processing");
            let _ = app.emit(
                "pipeline-progress",
                json!({
                    "jobId": job_id,
                    "stage": "processing",
                    "progress": pct,
                    "message": format!("{}%", pct),
                    "outputPath": null
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
            create_project,
            get_project,
            start_job,
            get_job_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
