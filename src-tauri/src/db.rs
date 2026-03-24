use dirs::data_dir;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClipMeta {
    pub filename: String,
    pub local_path: String, // Windows path e.g. C:\clips\DJI_01.MP4
    pub size_bytes: i64,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub has_audio: bool,
    pub thumbnail_data: Option<String>, // base64 data URI from scan.py
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub clip_count: i64,
    pub last_job_id: Option<String>,
    pub last_job_status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Clip {
    pub id: String,
    pub project_id: String,
    pub filename: String,
    pub local_path: String,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub has_audio: bool,
    pub thumbnail_data: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectWithClips {
    pub project: Project,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub progress_pct: i64,
    pub local_output_path: Option<String>,
    pub settings_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// DB path helper
// ---------------------------------------------------------------------------

pub fn db_path() -> std::path::PathBuf {
    data_dir()
        .unwrap()
        .join("rushcut")
        .join("rushcut.db")
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

pub fn init(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = db_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    let conn = Connection::open(&path)?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clips (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            local_path TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            has_audio INTEGER NOT NULL DEFAULT 0,
            thumbnail_data TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            progress_pct INTEGER NOT NULL DEFAULT 0,
            local_output_path TEXT,
            settings_json TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        );
    ")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

pub fn insert_project(name: &str, project_id: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let ts = now();
    conn.execute(
        "INSERT INTO projects (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![project_id, name, ts],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Clip helpers
// ---------------------------------------------------------------------------

pub fn insert_clip(clip: &Clip) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "INSERT INTO clips (id, project_id, filename, local_path, duration_ms, width, height, has_audio, thumbnail_data, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            clip.id,
            clip.project_id,
            clip.filename,
            clip.local_path,
            clip.duration_ms,
            clip.width,
            clip.height,
            clip.has_audio as i64,
            clip.thumbnail_data,
            clip.sort_order,
            clip.created_at,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

pub fn insert_job(job: &Job) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "INSERT INTO jobs (id, project_id, status, progress_pct, local_output_path, settings_json, error_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            job.id,
            job.project_id,
            job.status,
            job.progress_pct,
            job.local_output_path,
            job.settings_json,
            job.error_message,
            job.created_at,
            job.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_job_progress(job_id: &str, progress_pct: i64, status: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let ts = now();
    conn.execute(
        "UPDATE jobs SET progress_pct = ?1, status = ?2, updated_at = ?3 WHERE id = ?4",
        params![progress_pct, status, ts, job_id],
    )?;
    Ok(())
}

pub fn update_job_done(job_id: &str, output_path: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let ts = now();
    conn.execute(
        "UPDATE jobs SET status = 'done', progress_pct = 100, local_output_path = ?1, updated_at = ?2 WHERE id = ?3",
        params![output_path, ts, job_id],
    )?;
    Ok(())
}

pub fn update_job_error(job_id: &str, error_message: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let ts = now();
    conn.execute(
        "UPDATE jobs SET status = 'failed', error_message = ?1, updated_at = ?2 WHERE id = ?3",
        params![error_message, ts, job_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

pub fn get_project_with_clips(project_id: &str) -> Result<ProjectWithClips, rusqlite::Error> {
    let conn = Connection::open(db_path())?;

    let project = conn.query_row(
        "SELECT id, name, created_at FROM projects WHERE id = ?1",
        params![project_id],
        |row| Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
        }),
    )?;

    let mut stmt = conn.prepare(
        "SELECT id, project_id, filename, local_path, duration_ms, width, height, has_audio, thumbnail_data, sort_order, created_at
         FROM clips WHERE project_id = ?1 ORDER BY sort_order ASC",
    )?;
    let clips: Vec<Clip> = stmt
        .query_map(params![project_id], |row| {
            let has_audio_int: i64 = row.get(7)?;
            Ok(Clip {
                id: row.get(0)?,
                project_id: row.get(1)?,
                filename: row.get(2)?,
                local_path: row.get(3)?,
                duration_ms: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                has_audio: has_audio_int != 0,
                thumbnail_data: row.get(8)?,
                sort_order: row.get(9)?,
                created_at: row.get(10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ProjectWithClips { project, clips })
}

pub fn get_job(job_id: &str) -> Result<Job, rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.query_row(
        "SELECT id, project_id, status, progress_pct, local_output_path, settings_json, error_message, created_at, updated_at
         FROM jobs WHERE id = ?1",
        params![job_id],
        |row| Ok(Job {
            id: row.get(0)?,
            project_id: row.get(1)?,
            status: row.get(2)?,
            progress_pct: row.get(3)?,
            local_output_path: row.get(4)?,
            settings_json: row.get(5)?,
            error_message: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        }),
    )
}

pub fn list_projects() -> Result<Vec<ProjectSummary>, rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let mut stmt = conn.prepare(
        "SELECT
            p.id, p.name, p.created_at,
            (SELECT COUNT(*) FROM clips WHERE project_id = p.id) as clip_count,
            (SELECT id FROM jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as last_job_id,
            (SELECT status FROM jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as last_job_status
         FROM projects p
         ORDER BY p.created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                clip_count: row.get(3)?,
                last_job_id: row.get(4)?,
                last_job_status: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

pub fn now() -> String {
    // ISO-8601 UTC without chrono dep — uses std time
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple RFC-3339 approximation sufficient for sorting/display
    let s = secs;
    let sec = s % 60;
    let min = (s / 60) % 60;
    let hour = (s / 3600) % 24;
    let days = s / 86400;
    // days since epoch -> year/month/day (good enough for 2020-2099)
    let (year, month, day) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hour, min, sec)
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719468;
    let era = days / 146097;
    let doe = days % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
