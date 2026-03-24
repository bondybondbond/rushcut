mod db;

use tauri::Emitter;

pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
