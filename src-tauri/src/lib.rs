mod backup;
mod logger;
mod onedrive;
mod restore;
mod users;

use backup::{BackupManifest, BackupOptions, EngineCmd};
use restore::{RestoreOptions, DriveRestoreOptions};
use users::{WindowsUser, ExtraFolder, ExternalSource};

use tauri::Manager;
use tokio::sync::watch;
use std::sync::Mutex;

// ── Engine control managed state ──────────────────────────────────────────────

/// Holds the sender side of the engine control channel so that
/// pause/resume/cancel commands can signal the running backup/restore task.
struct EngineControl(Mutex<Option<watch::Sender<EngineCmd>>>);

// ── Admin check ───────────────────────────────────────────────────────────────

/// Returns true if the current process is running with Administrator privileges.
/// The UI uses this to show a warning banner before the user tries to scan profiles.
#[tauri::command]
fn check_admin() -> bool {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        // Attempting to open HKLM for writing is the most reliable way
        // to determine if we have admin rights without calling undocumented APIs.
        let result = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
                KEY_WRITE,
            )
            .is_ok();
        log::info!("check_admin → {}", result);
        result
    }
    #[cfg(not(windows))]
    {
        true
    }
}

// ── User commands ─────────────────────────────────────────────────────────────

/// Returns all Windows user profiles from C:\Users with sizes.
/// Runs in a blocking thread so the UI stays responsive during the scan.
#[tauri::command]
async fn get_local_users() -> Result<Vec<WindowsUser>, String> {
    log::info!("→ get_local_users");
    tauri::async_runtime::spawn_blocking(users::get_local_users)
        .await
        .map_err(|e| {
            log::error!("get_local_users failed: {e}");
            format!("Scan failed: {e}")
        })
}

/// Returns user profiles from an external drive's \Users folder.
#[tauri::command]
async fn get_external_users(drive_path: String) -> Result<Vec<WindowsUser>, String> {
    log::info!("→ get_external_users({})", drive_path);
    tauri::async_runtime::spawn_blocking(move || users::get_external_users(&drive_path))
        .await
        .map_err(|e| {
            log::error!("get_external_users failed: {e}");
            format!("Scan failed: {e}")
        })
}

/// Scans every drive letter (A–Z, skipping C:) for restore sources:
/// root-level backup folders (manifest.json) and \Users\ directories from
/// pulled drives. Returns a unified list used by the Restore tab.
#[tauri::command]
async fn scan_external_sources() -> Result<Vec<ExternalSource>, String> {
    log::info!("→ scan_external_sources");
    tauri::async_runtime::spawn_blocking(users::scan_external_sources)
        .await
        .map_err(|e| {
            log::error!("scan_external_sources failed: {e}");
            format!("Scan failed: {e}")
        })
}

/// Creates a directory (and all parents) at the given path.
/// Used by the UI to pre-create the destination folder so it is visible in the
/// folder-picker dialog the next time the user clicks Browse.
#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    log::info!("→ create_dir({})", path);
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| format!("Cannot create directory '{}': {}", path, e))
}

/// Returns the browser keys whose AppData folders exist in the given profile.
/// Result is used by the UI to show only installed browsers in the selection list.
#[tauri::command]
async fn detect_browsers(profile_path: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || backup::detect_browsers(&profile_path))
        .await
        .unwrap_or_default()
}

/// Returns the OneDrive root path for the given user SID, or null if OneDrive
/// is not configured. Used by the UI to show OneDrive in the Folders Included list.
#[tauri::command]
async fn detect_onedrive(sid: String, profile_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        onedrive::get_user_folder_paths(&sid, &profile_path).one_drive_root
    })
    .await
    .unwrap_or(None)
}

/// Returns extra folders found in the profile root that aren't covered by the
/// standard backup set (Desktop, Documents, etc.). Sorted largest-first.
#[tauri::command]
async fn detect_extra_folders(profile_path: String) -> Vec<ExtraFolder> {
    tauri::async_runtime::spawn_blocking(move || users::detect_extra_folders(&profile_path))
        .await
        .unwrap_or_default()
}

/// Returned by `detect_quickbooks`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickbooksInfo {
    /// Path to C:\Users\Public\Documents\Intuit if it exists and is non-empty.
    public_path: Option<String>,
    /// .QBW filenames found inside the user's Documents folder (depth <= 4).
    /// These are already covered by the standard backup; shown for informational purposes.
    documents_files: Vec<String>,
}

/// Checks for QuickBooks company files in two locations:
/// 1. C:\Users\Public\Documents\Intuit (shared installer default)
/// 2. The user's Documents folder up to 4 levels deep (already covered, shown for info)
#[tauri::command]
async fn detect_quickbooks(profile_path: String) -> QuickbooksInfo {
    tauri::async_runtime::spawn_blocking(move || {
        // ── Public shared location ─────────────────────────────────────────────
        let public_path = {
            #[cfg(windows)]
            {
                let p = std::path::PathBuf::from(r"C:\Users\Public\Documents\Intuit");
                if p.exists() {
                    if let Ok(mut entries) = std::fs::read_dir(&p) {
                        if entries.next().is_some() {
                            Some(p.to_string_lossy().into_owned())
                        } else { None }
                    } else { None }
                } else { None }
            }
            #[cfg(not(windows))]
            { None }
        };

        // ── User Documents scan (.QBW files, depth <= 4) ──────────────────────
        let docs = std::path::PathBuf::from(&profile_path).join("Documents");
        let documents_files: Vec<String> = if docs.exists() {
            walkdir::WalkDir::new(&docs)
                .max_depth(4)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.eq_ignore_ascii_case("qbw"))
                        .unwrap_or(false)
                })
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                .collect()
        } else {
            Vec::new()
        };

        QuickbooksInfo { public_path, documents_files }
    })
    .await
    .unwrap_or_else(|_| QuickbooksInfo { public_path: None, documents_files: Vec::new() })
}

/// Opens the given folder path in Windows Explorer (or the OS file manager).
#[tauri::command]
async fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    log::info!("→ open_folder({})", path);
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("Cannot open folder: {}", e))
}

// ── Operation commands ────────────────────────────────────────────────────────

/// Starts a backup (or direct-restore) operation.
/// Creates a fresh engine control channel, stores the sender in managed state,
/// and spawns the backup task. Returns immediately — progress is emitted via
/// Tauri events on the "progress" channel.
#[tauri::command]
async fn start_backup(
    app: tauri::AppHandle,
    options: BackupOptions,
    engine: tauri::State<'_, EngineControl>,
) -> Result<(), String> {
    log::info!(
        "→ start_backup (direct_restore={})",
        options.direct_restore
    );

    let (tx, rx) = watch::channel(EngineCmd::Running);

    // Store sender; any previous operation is dropped (and its task will see
    // the channel closed on the next check_engine call).
    *engine.0.lock().unwrap() = Some(tx);

    // Spawn the backup engine as a detached async task.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = backup::run_backup(options, app, rx).await {
            log::error!("start_backup: engine error: {}", e);
            // Emit a cleanup event so the frontend knows the operation ended.
            use tauri::Emitter;
            let _ = app2.emit("progress", backup::ProgressEvent {
                is_running: false,
                is_paused: false,
                current_file: String::new(),
                file_progress: 0.0,
                overall_progress: 0.0,
                files_copied: 0,
                total_files: 0,
                bytes_copied: 0,
                total_bytes: 0,
                error_count: 1,
                operation: None,
            });
        }
    });

    Ok(())
}

#[tauri::command]
async fn start_restore(
    app: tauri::AppHandle,
    options: RestoreOptions,
    engine: tauri::State<'_, EngineControl>,
) -> Result<(), String> {
    log::info!(
        "→ start_restore(backup='{}' target='{}')",
        options.backup_path, options.target_username
    );

    let (tx, rx) = watch::channel(EngineCmd::Running);
    *engine.0.lock().unwrap() = Some(tx);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = restore::run_restore(options, app, rx).await {
            log::error!("start_restore: engine error: {}", e);
            use tauri::Emitter;
            let _ = app2.emit("progress", backup::ProgressEvent {
                is_running: false,
                is_paused: false,
                current_file: String::new(),
                file_progress: 0.0,
                overall_progress: 0.0,
                files_copied: 0,
                total_files: 0,
                bytes_copied: 0,
                total_bytes: 0,
                error_count: 1,
                operation: None,
            });
        }
    });

    Ok(())
}

/// Restores standard user folders directly from an external drive profile
/// (no manifest required). Scans the source profile for standard folders
/// and any OneDrive directory, then copies them to the local target profile.
#[tauri::command]
async fn start_drive_restore(
    app: tauri::AppHandle,
    options: DriveRestoreOptions,
    engine: tauri::State<'_, EngineControl>,
) -> Result<(), String> {
    log::info!(
        "→ start_drive_restore(source='{}' target='{}')",
        options.source_profile_path, options.target_username
    );

    let (tx, rx) = watch::channel(EngineCmd::Running);
    *engine.0.lock().unwrap() = Some(tx);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = restore::run_drive_restore(options, app, rx).await {
            log::error!("start_drive_restore: engine error: {}", e);
            use tauri::Emitter;
            let _ = app2.emit("progress", backup::ProgressEvent {
                is_running: false,
                is_paused: false,
                current_file: String::new(),
                file_progress: 0.0,
                overall_progress: 0.0,
                files_copied: 0,
                total_files: 0,
                bytes_copied: 0,
                total_bytes: 0,
                error_count: 1,
                operation: None,
            });
        }
    });

    Ok(())
}

#[tauri::command]
async fn pause_operation(engine: tauri::State<'_, EngineControl>) -> Result<(), String> {
    log::info!("→ pause_operation");
    let guard = engine.0.lock().unwrap();
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(EngineCmd::Paused);
    }
    Ok(())
}

#[tauri::command]
async fn resume_operation(engine: tauri::State<'_, EngineControl>) -> Result<(), String> {
    log::info!("→ resume_operation");
    let guard = engine.0.lock().unwrap();
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(EngineCmd::Running);
    }
    Ok(())
}

#[tauri::command]
async fn cancel_operation(
    delete_partial: bool,
    engine: tauri::State<'_, EngineControl>,
) -> Result<(), String> {
    log::info!("→ cancel_operation(delete_partial={})", delete_partial);
    let guard = engine.0.lock().unwrap();
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(EngineCmd::Cancelled { delete_partial });
    }
    Ok(())
}

// ── Manifest / log commands ───────────────────────────────────────────────────

/// Returns the tail of the application log file as a UTF-8 string.
/// Reads up to the last 64 KB so the response stays fast regardless of how
/// much has been logged in previous sessions.
#[tauri::command]
async fn read_log_file(app: tauri::AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Cannot locate log directory: {}", e))?;

    let log_path = log_dir.join("ptcg-backup-tool.log");

    if !log_path.exists() {
        return Ok(String::new());
    }

    let bytes = tokio::fs::read(&log_path)
        .await
        .map_err(|e| format!("Cannot read log file: {}", e))?;

    const MAX_BYTES: usize = 65_536; // 64 KB
    let (slice, truncated) = if bytes.len() > MAX_BYTES {
        (&bytes[bytes.len() - MAX_BYTES..], true)
    } else {
        (bytes.as_slice(), false)
    };

    let text = String::from_utf8_lossy(slice);
    if truncated {
        // Skip the first (possibly partial) line so we don't show half a log entry.
        let after_first_newline = text.find('\n').map(|i| &text[i + 1..]).unwrap_or(&text);
        Ok(format!("[… earlier entries omitted …]\n{}", after_first_newline))
    } else {
        Ok(text.into_owned())
    }
}

#[tauri::command]
async fn read_manifest(backup_path: String) -> Result<BackupManifest, String> {
    log::info!("→ read_manifest({})", backup_path);
    // Offload the synchronous file read so the async runtime stays unblocked.
    tauri::async_runtime::spawn_blocking(move || {
        restore::read_manifest_file(&backup_path)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
async fn open_log_file(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    log::info!("→ open_log_file");

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Cannot locate log directory: {}", e))?;

    let log_path = log_dir.join("ptcg-backup-tool.log");

    if !log_path.exists() {
        return Err("No log file found yet — run a backup or restore first.".to_string());
    }

    let path_str = log_path
        .to_str()
        .ok_or_else(|| "Log path contains invalid characters".to_string())?;

    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| format!("Cannot open log file: {}", e))
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Structured logging: visible in the terminal, browser devtools, and a log file.
        // During dev — right-click the app window → Inspect → Console to see Rust logs.
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    // Terminal where you ran `npm run tauri dev`
                    tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ),
                    // Browser devtools console (right-click → Inspect)
                    tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Webview,
                    ),
                    // %APPDATA%\com.pete.ptcg-backup-tool\logs\ptcg-backup-tool.log
                    tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("ptcg-backup-tool".into()),
                        },
                    ),
                ])
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Register the engine control channel so all commands can access it.
        .manage(EngineControl(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            check_admin,
            get_local_users,
            get_external_users,
            scan_external_sources,
            create_dir,
            detect_browsers,
            detect_onedrive,
            detect_extra_folders,
            detect_quickbooks,
            open_folder,
            start_backup,
            start_restore,
            start_drive_restore,
            pause_operation,
            resume_operation,
            cancel_operation,
            read_manifest,
            read_log_file,
            open_log_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
