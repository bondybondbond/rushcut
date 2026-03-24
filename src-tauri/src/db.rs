use dirs::data_dir;
use rusqlite::Connection;
use tauri::AppHandle;

pub fn init(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = data_dir()
        .unwrap()
        .join("rushcut")
        .join("rushcut.db");
    std::fs::create_dir_all(db_path.parent().unwrap())?;
    let conn = Connection::open(&db_path)?;
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
            duration_ms INTEGER,
            width INTEGER,
            height INTEGER,
            has_audio INTEGER,
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
