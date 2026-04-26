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
    pub thumbnail_data: Option<String>, // base64 data URI
    pub codec_name: Option<String>,     // e.g. "hevc", "h264"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub clip_count: i64,
    pub last_job_id: Option<String>,
    pub last_job_status: Option<String>,
    pub first_clip_thumbnail: Option<String>,
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
    // -- Review fields (Batch 14c) --
    pub in_ms: Option<i64>,
    pub out_ms: Option<i64>,
    pub focal_x: Option<f64>,
    pub focal_y: Option<f64>,
    pub zoom_mode: Option<String>,  // "gentle" | "medium" | "tight"
    pub include: i64,               // 1 = include, 0 = skip
    pub proxy_path: Option<String>,
    pub waveform_data: Option<String>,
    pub codec_name: Option<String>, // e.g. "hevc", "h264" — set at scan time, read by proxy gen
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
    pub analysis_summary: Option<String>,
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

    // Additive migration: analysis_summary column (Batch 13).
    // SQLite has no ADD COLUMN IF NOT EXISTS, so guard with pragma_table_info.
    let col_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name='analysis_summary'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !col_exists {
        conn.execute("ALTER TABLE jobs ADD COLUMN analysis_summary TEXT", [])?;
    }

    // Additive migrations: per-clip review fields (Batch 14c) + waveform (Batch 15c) + codec (Batch 16).
    let clip_cols = [
        ("in_ms",        "INTEGER"),
        ("out_ms",       "INTEGER"),
        ("focal_x",      "REAL"),
        ("focal_y",      "REAL"),
        ("zoom_mode",    "TEXT"),
        ("include",      "INTEGER DEFAULT 0"),
        ("proxy_path",   "TEXT"),
        ("waveform_data","TEXT"),
        ("codec_name",   "TEXT"),
    ];
    for (col_name, col_type) in &clip_cols {
        let exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name=?1",
            params![col_name],
            |r| r.get::<_, i64>(0),
        )? > 0;
        if !exists {
            conn.execute(
                &format!("ALTER TABLE clips ADD COLUMN {} {}", col_name, col_type),
                [],
            )?;
        }
    }

    // Settings table — key/value store for one-time migrations (Batch 15a+).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )?;

    // Batch 15a: one-time reset to explicit-add model (include=0).
    // Guarded by settings key so it only runs once, not on every startup.
    let already_reset: bool = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key='batch15a_include_reset'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !already_reset {
        conn.execute("UPDATE clips SET include = 0", [])?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('batch15a_include_reset', 'done')",
            [],
        )?;
    }

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

pub fn rename_project(project_id: &str, name: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "UPDATE projects SET name = ?1 WHERE id = ?2",
        params![name, project_id],
    )?;
    Ok(())
}

/// Return all local_output_path values for jobs belonging to a project.
/// Used by delete_project_cmd to clean up rendered MP4 files from disk before removing DB rows.
pub fn get_project_output_paths(project_id: &str) -> Result<Vec<String>, rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let mut stmt = conn.prepare(
        "SELECT local_output_path FROM jobs WHERE project_id = ?1 AND local_output_path IS NOT NULL",
    )?;
    let paths: Vec<String> = stmt
        .query_map(params![project_id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(paths)
}

/// Delete a project and all its clips and jobs.
/// Schema has no ON DELETE CASCADE, so order matters: clips -> jobs -> projects.
pub fn delete_project(project_id: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute("DELETE FROM clips WHERE project_id = ?1", params![project_id])?;
    conn.execute("DELETE FROM jobs WHERE project_id = ?1", params![project_id])?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Clip helpers
// ---------------------------------------------------------------------------

/// Insert a clip with core metadata only.
/// `include` is explicitly written as 0 — explicit-add model; user adds clips to film in Trimmer.
/// Never rely on the SQLite column DEFAULT — it was historically DEFAULT 1 and existing DBs
/// would keep that default even after migration code changes.
/// Other review fields (in_ms, out_ms, focal_x/y, zoom_mode, proxy_path)
/// intentionally omitted — set via update_clip_review / update_clip_proxy.
pub fn insert_clip(clip: &Clip) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "INSERT INTO clips (id, project_id, filename, local_path, duration_ms, width, height, has_audio, thumbnail_data, sort_order, created_at, include, codec_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)",
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
            clip.codec_name,
        ],
    )?;
    Ok(())
}

/// Update per-clip review fields (set by user in the Review screen).
/// Clamps focal_x/focal_y to 0.0-1.0 range.
pub fn update_clip_review(
    clip_id: &str,
    in_ms: Option<i64>,
    out_ms: Option<i64>,
    focal_x: Option<f64>,
    focal_y: Option<f64>,
    zoom_mode: Option<String>,
    include: i64,
) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let fx = focal_x.map(|v| v.clamp(0.0, 1.0));
    let fy = focal_y.map(|v| v.clamp(0.0, 1.0));
    conn.execute(
        "UPDATE clips SET in_ms = ?1, out_ms = ?2, focal_x = ?3, focal_y = ?4,
         zoom_mode = ?5, include = ?6 WHERE id = ?7",
        params![in_ms, out_ms, fx, fy, zoom_mode, include, clip_id],
    )?;
    Ok(())
}

/// Update the proxy path for a clip (set by proxy generation pipeline).
pub fn update_clip_proxy(clip_id: &str, proxy_path: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "UPDATE clips SET proxy_path = ?1 WHERE id = ?2",
        params![proxy_path, clip_id],
    )?;
    Ok(())
}

/// Update the thumbnail data for a clip (raw base64 JPEG, no data URI prefix).
pub fn update_clip_thumbnail(clip_id: &str, thumbnail_data: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "UPDATE clips SET thumbnail_data = ?1 WHERE id = ?2",
        params![thumbnail_data, clip_id],
    )?;
    Ok(())
}

/// Update the waveform PNG data for a clip (raw base64 PNG, no data URI prefix).
pub fn update_clip_waveform(clip_id: &str, waveform_data: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "UPDATE clips SET waveform_data = ?1 WHERE id = ?2",
        params![waveform_data, clip_id],
    )?;
    Ok(())
}

/// Update sort_order for a list of clip IDs. Caller passes clips in desired order;
/// each clip gets sort_order = its index in the list.
pub fn reorder_clips(clip_ids: &[String]) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch("BEGIN")?;
    for (i, id) in clip_ids.iter().enumerate() {
        conn.execute(
            "UPDATE clips SET sort_order = ?1 WHERE id = ?2",
            params![i as i64, id],
        )?;
    }
    conn.execute_batch("COMMIT")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

pub fn insert_job(job: &Job) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.execute(
        "INSERT INTO jobs (id, project_id, status, progress_pct, local_output_path, settings_json, error_message, analysis_summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            job.id,
            job.project_id,
            job.status,
            job.progress_pct,
            job.local_output_path,
            job.settings_json,
            job.error_message,
            job.analysis_summary,
            job.created_at,
            job.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_job_analysis(job_id: &str, analysis_summary: &str) -> Result<(), rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    let ts = now();
    conn.execute(
        "UPDATE jobs SET analysis_summary = ?1, updated_at = ?2 WHERE id = ?3",
        params![analysis_summary, ts, job_id],
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
        // Column index map:
        //  0:id  1:project_id  2:filename  3:local_path  4:duration_ms
        //  5:width  6:height  7:has_audio  8:thumbnail_data  9:sort_order
        // 10:created_at  11:in_ms  12:out_ms  13:focal_x  14:focal_y
        // 15:zoom_mode  16:include  17:proxy_path  18:waveform_data  19:codec_name
        "SELECT id, project_id, filename, local_path, duration_ms, width, height,
                has_audio, thumbnail_data, sort_order, created_at,
                in_ms, out_ms, focal_x, focal_y, zoom_mode, include, proxy_path, waveform_data,
                codec_name
         FROM clips WHERE project_id = ?1 ORDER BY sort_order ASC",
    )?;
    let clips: Vec<Clip> = stmt
        .query_map(params![project_id], |row| {
            let has_audio_int: i64 = row.get(7)?;
            Ok(Clip {
                id: row.get(0)?,              // 0
                project_id: row.get(1)?,      // 1
                filename: row.get(2)?,        // 2
                local_path: row.get(3)?,      // 3
                duration_ms: row.get(4)?,     // 4
                width: row.get(5)?,           // 5
                height: row.get(6)?,          // 6
                has_audio: has_audio_int != 0, // 7
                thumbnail_data: row.get(8)?,  // 8
                sort_order: row.get(9)?,      // 9
                created_at: row.get(10)?,     // 10
                in_ms: row.get(11)?,          // 11
                out_ms: row.get(12)?,         // 12
                focal_x: row.get(13)?,        // 13
                focal_y: row.get(14)?,        // 14
                zoom_mode: row.get(15)?,      // 15
                include: row.get::<_, Option<i64>>(16)?.unwrap_or(0), // 16 — default 0 (explicit-add)
                proxy_path: row.get(17)?,     // 17
                waveform_data: row.get(18)?,  // 18
                codec_name: row.get(19)?,     // 19
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ProjectWithClips { project, clips })
}

pub fn get_job(job_id: &str) -> Result<Job, rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    conn.query_row(
        "SELECT id, project_id, status, progress_pct, local_output_path, settings_json, error_message, analysis_summary, created_at, updated_at
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
            analysis_summary: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        }),
    )
}

pub fn list_projects() -> Result<Vec<ProjectSummary>, rusqlite::Error> {
    let conn = Connection::open(db_path())?;
    // Mark jobs that have been stuck in "processing" for over 60 minutes as failed.
    // Catches pipelines that crashed without emitting an error event.
    conn.execute(
        "UPDATE jobs SET status = 'failed', error_message = 'Pipeline timed out (no response for 60 min)'
         WHERE status = 'processing' AND created_at < datetime('now', '-60 minutes')",
        [],
    )?;
    let mut stmt = conn.prepare(
        "SELECT
            p.id, p.name, p.created_at,
            (SELECT COUNT(*) FROM clips WHERE project_id = p.id) as clip_count,
            (SELECT id FROM jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as last_job_id,
            (SELECT status FROM jobs WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) as last_job_status,
            (SELECT thumbnail_data FROM clips WHERE project_id = p.id ORDER BY sort_order ASC LIMIT 1) as first_clip_thumbnail
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
                first_clip_thumbnail: row.get(6)?,
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
