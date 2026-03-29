// Backup engine — Phase 3.
//
// Handles:
// - Building source list (profile folders + selected browser AppData paths)
// - Pre-scan (total file count + bytes for accurate progress)
// - Chunked file copy with per-file and overall progress events
// - Pause / cancel via tokio watch channel
// - Per-file error collection → errors.log
// - Writing manifest.json on completion (normal backup only)

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::sync::watch;
use log::{error, info, warn};

use crate::onedrive::get_user_folder_paths;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOptions {
    pub source_path: String,
    pub destination_path: String,
    pub sid: String,
    pub include_browsers: Vec<String>,
    pub direct_restore: bool,
    #[allow(dead_code)] // deserialized from frontend; used by direct-restore JS path
    pub target_sid: Option<String>,
    pub target_username: Option<String>,
    pub dry_run: bool,
    pub extra_folders: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub username: String,
    pub sid: String,
    pub timestamp: String,
    pub source_computer: String,
    pub total_files: u64,
    pub total_size_bytes: u64,
    pub folders_included: Vec<String>,
    pub browsers_included: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_drive_path: Option<String>,
}

/// Commands the UI can send to the running engine.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineCmd {
    Running,
    Paused,
    Cancelled { delete_partial: bool },
}

/// Progress payload emitted to the frontend on every meaningful state change.
/// Field names must match the TypeScript `ProgressState` interface exactly.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub is_running: bool,
    pub is_paused: bool,
    pub current_file: String,
    pub file_progress: f64,     // 0–100
    pub overall_progress: f64,  // 0–100
    pub files_copied: u64,
    pub total_files: u64,
    pub bytes_copied: u64,
    pub total_bytes: u64,
    pub error_count: u64,
    pub operation: Option<String>, // "backup" | "restore" | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

/// Folders that are always resolved via default profile path (not shell folders).
/// "Saved Games" has no standard Shell Folders registry entry.
const EXTRA_FOLDERS: &[&str] = &["Saved Games"];

/// Read/write chunk size for per-file progress (256 KB).
const COPY_BUF: usize = 256 * 1_024;

/// Emit a progress event at most once per this many bytes written to avoid
/// flooding the IPC channel on very fast storage.
const EMIT_EVERY_BYTES: u64 = 1_024 * 1_024; // 1 MB

// ── Engine entry point ────────────────────────────────────────────────────────

pub async fn run_backup(
    options: BackupOptions,
    app: tauri::AppHandle,
    ctrl_rx: watch::Receiver<EngineCmd>,
) -> Result<(), String> {
    let source = PathBuf::from(&options.source_path);
    let username = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    info!(
        "run_backup: user='{}' direct_restore={}",
        username, options.direct_restore
    );

    // ── Build source list ──────────────────────────────────────────────────────

    let mut sources: Vec<(String, PathBuf)> = Vec::new();

    // Resolve shell folder paths from the registry (handles OneDrive KFM redirect).
    let folder_paths = get_user_folder_paths(&options.sid, &options.source_path);
    let one_drive_root = folder_paths.one_drive_root.clone();

    let shell_folder_entries = [
        ("Desktop",   folder_paths.desktop.clone()),
        ("Documents", folder_paths.documents.clone()),
        ("Downloads", folder_paths.downloads.clone()),
        ("Pictures",  folder_paths.pictures.clone()),
        ("Music",     folder_paths.music.clone()),
        ("Videos",    folder_paths.videos.clone()),
        ("Favorites", folder_paths.favorites.clone()),
    ];

    // If OneDrive root exists, we'll back it up as a single "OneDrive" source so
    // that files outside the standard shell folders are included.  Shell folders
    // that are already inside the OneDrive root (KFM redirect) are skipped here
    // to avoid copying the same files twice.
    let od_root_path: Option<PathBuf> = one_drive_root
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.exists());

    for (key, path) in &shell_folder_entries {
        let abs = PathBuf::from(path);
        // Skip shell folders that live inside OneDrive — the full OneDrive
        // source below will cover them.
        if let Some(ref od) = od_root_path {
            if abs.starts_with(od) {
                info!("'{}' is inside OneDrive root — covered by OneDrive source", key);
                continue;
            }
        }
        if abs.exists() {
            sources.push((key.to_string(), abs));
        }
    }

    // Extra folders not tracked in Shell Folders (e.g. Saved Games).
    for &folder in EXTRA_FOLDERS {
        let abs = source.join(folder);
        if abs.exists() {
            sources.push((folder.to_string(), abs));
        }
    }

    // Include the entire OneDrive root so files outside standard shell folders
    // (work folders, loose files, etc.) are not missed.
    if let Some(od) = od_root_path {
        info!("Adding OneDrive root as source: {}", od.display());
        sources.push(("OneDrive".to_string(), od));
    }

    // User-selected extra folders (anything outside the standard set).
    for path_str in &options.extra_folders {
        let abs = PathBuf::from(path_str);
        if abs.exists() {
            let name = abs
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Extra")
                .to_string();
            info!("Adding extra folder '{}': {}", name, abs.display());
            sources.push((name, abs));
        }
    }

    for browser in &options.include_browsers {
        if let Some((rel, abs)) = browser_path(&options.source_path, browser) {
            if abs.exists() {
                sources.push((rel, abs));
            } else {
                info!("Browser '{}': path not found ({})", browser, abs.display());
            }
        }
    }

    if sources.is_empty() {
        return Err(format!(
            "No source folders found under '{}'. Is the profile path correct?",
            options.source_path
        ));
    }

    // ── Pre-scan: count total files and bytes ──────────────────────────────────

    let sources_for_scan = sources.clone();
    let (total_files, total_bytes) =
        tauri::async_runtime::spawn_blocking(move || count_all(&sources_for_scan))
            .await
            .map_err(|e| format!("Pre-scan task failed: {e}"))?;

    info!("Pre-scan: {} files, {} bytes", total_files, total_bytes);

    // ── Destination root ───────────────────────────────────────────────────────

    let dest_root: PathBuf = if options.direct_restore {
        // Copy directly into an existing local user's profile folder.
        let target = options.target_username.as_deref().unwrap_or("unknown");
        PathBuf::from(format!("C:\\Users\\{}", target))
    } else {
        // The frontend already appends \{username} to the destination path,
        // so use it as-is.
        PathBuf::from(&options.destination_path)
    };

    info!("dest_root: {}", dest_root.display());

    if options.dry_run {
        info!("[DRY RUN] *** NO FILES WILL BE WRITTEN ***");
        info!("[DRY RUN] source root : {}", options.source_path);
        info!("[DRY RUN] dest root   : {}", dest_root.display());
        info!("[DRY RUN] {} source dirs:", sources.len());
        for (rel, abs) in &sources {
            info!("[DRY RUN]   {} ({})", rel, abs.display());
        }
        info!("[DRY RUN] total: {} files, {} bytes", total_files, total_bytes);
    }

    // ── Initial progress event ─────────────────────────────────────────────────

    let mut prog = ProgressEvent {
        is_running: true,
        is_paused: false,
        current_file: String::new(),
        file_progress: 0.0,
        overall_progress: 0.0,
        files_copied: 0,
        total_files,
        bytes_copied: 0,
        total_bytes,
        error_count: 0,
        operation: Some("backup".to_string()),
    };
    emit(&app, &prog);

    let mut ctrl = ctrl_rx;
    let mut error_log: Vec<String> = Vec::new();

    // ── Copy loop ──────────────────────────────────────────────────────────────

    for (rel_prefix, abs_src) in &sources {
        // Collect file entries from this source directory without blocking the
        // async runtime — walkdir is synchronous I/O.
        let src_clone = abs_src.clone();
        let is_browser = rel_prefix.starts_with("AppData-");
        let key_clone = rel_prefix.clone();
        let file_entries = tauri::async_runtime::spawn_blocking(move || {
            walkdir::WalkDir::new(&src_clone)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .filter(|e| !is_browser || should_include_browser_file(&key_clone, e.path()))
                .map(|e| {
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    (e.path().to_path_buf(), size)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("Directory scan failed: {e}"))?;

        for (src_path, file_size) in file_entries {
            // ── Pause / cancel check ───────────────────────────────────────────
            match check_engine(&mut ctrl, &mut prog, &app).await {
                EngineAction::Cancel(delete_partial) => {
                    // Dry run never writes anything, so there is nothing to delete.
                    // For direct restore, dest_root is a live user profile — never delete it.
                    if delete_partial && !options.dry_run && !options.direct_restore {
                        delete_with_retry(&dest_root).await;
                    }
                    prog.is_running = false;
                    prog.operation = None;
                    emit(&app, &prog);
                    return Ok(());
                }
                EngineAction::Continue => {}
            }

            // ── Compute destination path ───────────────────────────────────────
            let rel_to_src = match src_path.strip_prefix(abs_src) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            // In direct-restore mode the destination is a live user profile, so
            // browser keys must be mapped to their real AppData sub-paths.
            let dest_rel = if options.direct_restore {
                profile_subdir(rel_prefix)
            } else {
                rel_prefix
            };
            let dst_path = dest_root.join(dest_rel).join(&rel_to_src);

            let file_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Skip OneDrive cloud-only placeholders — the file lives in the cloud
            // and hasn't been downloaded locally. No point copying it; it's already
            // backed up by OneDrive. Log as a warning, not an error.
            if is_cloud_placeholder(&src_path) {
                warn!("[CLOUD] skipping cloud-only placeholder: {}", src_path.display());
                continue;
            }

            prog.current_file = if options.dry_run {
                format!("[TEST] {}", file_name)
            } else {
                file_name
            };
            prog.file_progress = 0.0;
            emit(&app, &prog);

            if options.dry_run {
                // ── Dry run: log and advance counters without touching the filesystem ──
                info!("[DRY RUN] {} → {}", src_path.display(), dst_path.display());
                prog.files_copied += 1;
                prog.bytes_copied += file_size;
                prog.file_progress = 100.0;
                prog.overall_progress = if total_bytes > 0 {
                    prog.bytes_copied as f64 / total_bytes as f64 * 100.0
                } else {
                    prog.files_copied as f64 / total_files.max(1) as f64 * 100.0
                };
                emit(&app, &prog);
            } else {
                // ── Real copy ──────────────────────────────────────────────────────────

                // Ensure destination parent directory exists.
                if let Some(parent) = dst_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        error!("mkdir {}: {}", parent.display(), e);
                        prog.error_count += 1;
                        error_log.push(format!("{}: {}", src_path.display(), e));
                        continue;
                    }
                }

                match copy_file_chunked(&src_path, &dst_path, file_size, &app, &mut prog).await {
                    Ok(bytes) => {
                        prog.files_copied += 1;
                        prog.bytes_copied += bytes;
                        prog.file_progress = 100.0;
                        prog.overall_progress = if total_bytes > 0 {
                            prog.bytes_copied as f64 / total_bytes as f64 * 100.0
                        } else {
                            prog.files_copied as f64 / total_files.max(1) as f64 * 100.0
                        };
                        emit(&app, &prog);
                    }
                    Err(e) => {
                        error!("copy {}: {}", src_path.display(), e);
                        prog.error_count += 1;
                        error_log.push(format!("{}: {}", src_path.display(), e));
                    }
                }
            }
        }
    }

    // ── Write manifest (normal backup only, never in dry run) ─────────────────

    if options.dry_run {
        info!(
            "[DRY RUN] complete — {} files, {} bytes (nothing written)",
            prog.files_copied, prog.bytes_copied
        );
    }

    if !options.direct_restore && !options.dry_run {
        let manifest = BackupManifest {
            username: username.clone(),
            sid: options.sid.clone(),
            timestamp: iso_now(),
            source_computer: computer_name(),
            total_files: prog.files_copied,
            total_size_bytes: prog.bytes_copied,
            folders_included: sources.iter().map(|(k, _)| k.clone()).collect(),
            browsers_included: options.include_browsers.clone(),
            one_drive_path: one_drive_root.clone(),
        };

        let manifest_path = dest_root.join("manifest.json");
        match serde_json::to_string_pretty(&manifest) {
            Ok(json) => {
                if let Err(e) = tokio::fs::write(&manifest_path, json).await {
                    error!("write manifest: {}", e);
                } else {
                    info!("manifest written to {}", manifest_path.display());
                }
            }
            Err(e) => error!("serialize manifest: {}", e),
        }
    }

    // ── Write error log (skipped in dry run) ──────────────────────────────────

    if !error_log.is_empty() && !options.dry_run {
        let log_path = dest_root.join("errors.log");
        let content = error_log.join("\n");
        if let Err(e) = tokio::fs::write(&log_path, content).await {
            error!("write errors.log: {}", e);
        } else {
            info!("{} errors logged to {}", error_log.len(), log_path.display());
        }
    }

    info!(
        "backup complete: {} files, {} bytes, {} errors",
        prog.files_copied, prog.bytes_copied, prog.error_count
    );

    prog.is_running = false;
    prog.overall_progress = 100.0;
    prog.file_progress = 100.0;
    prog.current_file = if options.dry_run {
        "Dry Run Complete".to_string()
    } else {
        "Complete".to_string()
    };
    prog.operation = None;
    emit(&app, &prog);

    Ok(())
}

// ── Engine control ────────────────────────────────────────────────────────────

pub enum EngineAction {
    Continue,
    Cancel(bool), // delete_partial
}

/// Checks the current engine command.
/// - Running  → returns Continue immediately (resets is_paused if needed).
/// - Paused   → sets is_paused, emits progress, then waits via watch::changed()
///              until the sender sends a new value.
/// - Cancelled → returns Cancel(delete_partial).
pub async fn check_engine(
    ctrl: &mut watch::Receiver<EngineCmd>,
    prog: &mut ProgressEvent,
    app: &tauri::AppHandle,
) -> EngineAction {
    loop {
        // borrow_and_update() reads the latest value AND marks it as "seen"
        // so that the subsequent changed().await waits for a genuinely new send.
        let cmd = ctrl.borrow_and_update().clone();
        match cmd {
            EngineCmd::Running => {
                if prog.is_paused {
                    prog.is_paused = false;
                    emit(app, prog);
                }
                return EngineAction::Continue;
            }
            EngineCmd::Paused => {
                if !prog.is_paused {
                    prog.is_paused = true;
                    emit(app, prog);
                }
                // Block until the sender sends the next value (pause/resume/cancel).
                if ctrl.changed().await.is_err() {
                    // Sender dropped — treat as cancel without cleanup.
                    return EngineAction::Cancel(false);
                }
                // Loop and re-read the new state.
            }
            EngineCmd::Cancelled { delete_partial } => {
                prog.is_paused = false;
                return EngineAction::Cancel(delete_partial);
            }
        }
    }
}

// ── File copy with chunked progress ───────────────────────────────────────────

pub async fn copy_file_chunked(
    src: &Path,
    dst: &Path,
    file_size: u64,
    app: &tauri::AppHandle,
    prog: &mut ProgressEvent,
) -> std::io::Result<u64> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut reader = tokio::fs::File::open(src).await?;
    let mut writer = tokio::fs::File::create(dst).await?;

    let mut buf = vec![0u8; COPY_BUF];
    let mut written: u64 = 0;
    let mut last_emit_at: u64 = 0;

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
        written += n as u64;

        // Throttle progress events on large files.
        if file_size > 0 && written.saturating_sub(last_emit_at) >= EMIT_EVERY_BYTES {
            prog.file_progress = written as f64 / file_size as f64 * 100.0;
            emit(app, prog);
            last_emit_at = written;
        }
    }

    writer.flush().await?;
    Ok(written)
}

// ── Utility helpers ───────────────────────────────────────────────────────────

pub fn emit(app: &tauri::AppHandle, prog: &ProgressEvent) {
    use tauri::Emitter;
    if let Err(e) = app.emit("progress", prog) {
        warn!("emit 'progress': {}", e);
    }
}

/// Synchronously walk all source directories and return (file_count, total_bytes).
/// Intended to be called inside spawn_blocking.
pub fn count_all(sources: &[(String, PathBuf)]) -> (u64, u64) {
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    for (key, src) in sources {
        let is_browser = key.starts_with("AppData-");
        for entry in walkdir::WalkDir::new(src)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| !is_browser || should_include_browser_file(key, e.path()))
        {
            files += 1;
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (files, bytes)
}

/// Maps a backup folder key to the profile-relative subdirectory it should be
/// placed into when writing directly into a live user profile.
///
/// Profile folders (Desktop, Documents, …) map to themselves.
/// Browser AppData keys map to their full AppData sub-paths so files land in
/// the correct location rather than a bare "AppData-Chrome" directory.
///
/// Used by both the backup direct-restore path and the restore engine.
pub fn profile_subdir(key: &str) -> &str {
    match key {
        "AppData-Chrome"      => "AppData\\Local\\Google\\Chrome\\User Data",
        "AppData-Edge"        => "AppData\\Local\\Microsoft\\Edge\\User Data",
        "AppData-Brave"       => "AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
        "AppData-Firefox"     => "AppData\\Roaming\\Mozilla\\Firefox",
        "AppData-Opera"       => "AppData\\Roaming\\Opera Software\\Opera Stable",
        "AppData-Outlook"     => "AppData\\Local\\Microsoft\\Outlook",
        "AppData-Thunderbird" => "AppData\\Roaming\\Thunderbird\\Profiles",
        other                 => other,
    }
}

/// Returns true if `path` should be included when backing up browser data.
/// Only bookmark-related files are copied — not cache, history, passwords, etc.
///
/// Chromium (Chrome, Edge, Brave, Opera): `Default\Bookmarks` and `Default\Bookmarks.bak`
/// Firefox: any file inside a `bookmarkbackups` subfolder
fn should_include_browser_file(key: &str, path: &Path) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    match key {
        "AppData-Firefox" => {
            // Only the dated bookmark snapshot files inside bookmarkbackups/
            path.components().any(|c| c.as_os_str() == "bookmarkbackups")
        }
        "AppData-Outlook" => {
            // PST = personal mail store (keep). OST = offline cache (skip).
            path.extension().and_then(|e| e.to_str()) == Some("pst")
        }
        "AppData-Thunderbird" => {
            // Copy everything except Thunderbird's regenerable cache directories.
            !path.components().any(|c| {
                matches!(
                    c.as_os_str().to_str(),
                    Some("cache2") | Some("startupCache") | Some("OfflineCache")
                )
            })
        }
        _ => {
            // Chromium browsers: only the Bookmarks JSON files.
            file_name == "Bookmarks" || file_name == "Bookmarks.bak"
        }
    }
}

/// Resolves a browser name to its (relative key, absolute AppData path).
fn browser_path(profile_path: &str, browser: &str) -> Option<(String, PathBuf)> {
    let base = Path::new(profile_path);
    let (rel, sub) = match browser {
        "chrome"      => ("AppData-Chrome",      "AppData\\Local\\Google\\Chrome\\User Data"),
        "edge"        => ("AppData-Edge",        "AppData\\Local\\Microsoft\\Edge\\User Data"),
        "brave"       => ("AppData-Brave",       "AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data"),
        "firefox"     => ("AppData-Firefox",     "AppData\\Roaming\\Mozilla\\Firefox"),
        "opera"       => ("AppData-Opera",       "AppData\\Roaming\\Opera Software\\Opera Stable"),
        "outlook"     => ("AppData-Outlook",     "AppData\\Local\\Microsoft\\Outlook"),
        "thunderbird" => ("AppData-Thunderbird", "AppData\\Roaming\\Thunderbird\\Profiles"),
        _ => return None,
    };
    Some((rel.to_string(), base.join(sub)))
}

/// Removes a directory tree, retrying up to 3 times with increasing delays.
/// Windows Defender / Search Indexer commonly hold brief read locks on newly
/// written files; a short wait is usually enough to get a clean deletion.
async fn delete_with_retry(path: &Path) {
    for attempt in 1u32..=3 {
        match tokio::fs::remove_dir_all(path).await {
            Ok(_) => {
                info!("partial backup deleted (attempt {})", attempt);
                return;
            }
            Err(e) if attempt < 3 => {
                let delay_ms = attempt * 800;
                warn!(
                    "delete attempt {}/3 failed ({}), retrying in {}ms…",
                    attempt, e, delay_ms
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms as u64)).await;
            }
            Err(e) => {
                warn!(
                    "Could not delete partial backup after 3 attempts: {}. \
                     The folder may be locked by antivirus or the Search indexer.",
                    e
                );
            }
        }
    }
}

/// Returns the current UTC time as an ISO 8601 string (e.g. "2025-03-01T14:30:00Z").
/// Uses only std — no chrono dependency needed.
fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (year, month, day) = epoch_secs_to_ymd(secs);
    let h = ((secs / 3_600) % 24) as u32;
    let m = ((secs / 60) % 60) as u32;
    let s = (secs % 60) as u32;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, h, m, s)
}

/// Gregorian calendar conversion from Unix epoch seconds to (year, month, day).
fn epoch_secs_to_ymd(secs: u64) -> (u32, u32, u32) {
    let days = (secs / 86_400) as i64 + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    (y as u32, mo as u32, d as u32)
}

/// Returns the browser keys whose AppData folders actually exist under `profile_path`.
/// Called before the backup starts so the UI can show only installed browsers.
pub fn detect_browsers(profile_path: &str) -> Vec<String> {
    let base = Path::new(profile_path);
    [
        ("chrome",      "AppData\\Local\\Google\\Chrome\\User Data"),
        ("edge",        "AppData\\Local\\Microsoft\\Edge\\User Data"),
        ("brave",       "AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data"),
        ("firefox",     "AppData\\Roaming\\Mozilla\\Firefox"),
        ("opera",       "AppData\\Roaming\\Opera Software\\Opera Stable"),
        ("outlook",     "AppData\\Local\\Microsoft\\Outlook"),
        ("thunderbird", "AppData\\Roaming\\Thunderbird\\Profiles"),
    ]
    .iter()
    .filter_map(|(key, sub)| {
        if base.join(sub).exists() {
            Some(key.to_string())
        } else {
            None
        }
    })
    .collect()
}

/// Returns true if `path` is an OneDrive Files-On-Demand placeholder that has
/// not been downloaded to local storage.  On Windows these files carry the
/// `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000) or
/// `FILE_ATTRIBUTE_RECALL_ON_OPEN` (0x40000) attribute.  Trying to open them
/// would trigger a network recall which fails when OneDrive is offline.
/// On non-Windows platforms this always returns false.
#[cfg(windows)]
fn is_cloud_placeholder(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::metadata(path)
        .map(|m| {
            let attrs = m.file_attributes();
            const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000; // modern Files-On-Demand
            const RECALL_ON_OPEN: u32        = 0x0004_0000; // modern Files-On-Demand
            const OFFLINE: u32               = 0x0000_1000; // older OneDrive / SharePoint placeholders
            attrs & RECALL_ON_DATA_ACCESS != 0 || attrs & RECALL_ON_OPEN != 0 || attrs & OFFLINE != 0
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_cloud_placeholder(_path: &Path) -> bool { false }

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}
