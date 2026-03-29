// Restore engine — Phase 5.
//
// Handles:
// - Reading manifest.json to discover which folders were backed up
// - Walking the backup folder tree and copying files back to the target profile
// - Pause / cancel via the shared watch channel (same as backup engine)
// - Per-file error collection → restore_errors.log

use serde::Deserialize;
use std::path::PathBuf;
use tokio::sync::watch;
use log::{error, info, warn};

use crate::backup::{
    BackupManifest, EngineAction, EngineCmd, ProgressEvent,
    check_engine, copy_file_chunked, count_all, emit, profile_subdir,
};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    pub backup_path: String,
    #[allow(dead_code)] // deserialized from frontend; reserved for future SID-based path resolution
    pub target_sid: String,
    pub target_username: String,
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveRestoreOptions {
    /// Full path to the source user profile on the external drive,
    /// e.g. `D:\Users\Pete`.
    pub source_profile_path: String,
    /// Username of the local target profile, e.g. `John`.
    pub target_username: String,
    pub dry_run: bool,
}

/// Standard profile subdirectories to scan for in a drive-based restore.
const STANDARD_FOLDERS: &[&str] = &[
    "Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "Favorites",
];

// ── Engine entry point ────────────────────────────────────────────────────────

pub async fn run_restore(
    options: RestoreOptions,
    app: tauri::AppHandle,
    ctrl_rx: watch::Receiver<EngineCmd>,
) -> Result<(), String> {
    info!(
        "run_restore: backup='{}' target='{}'",
        options.backup_path, options.target_username
    );

    // ── Read manifest ──────────────────────────────────────────────────────────

    let manifest = read_manifest_file(&options.backup_path)?;
    info!(
        "manifest: {} folders, {} files from '{}'",
        manifest.folders_included.len(),
        manifest.total_files,
        manifest.source_computer
    );

    // ── Resolve restore paths ──────────────────────────────────────────────────

    let target_root = PathBuf::from(format!("C:\\Users\\{}", options.target_username));
    info!("target_root: {}", target_root.display());

    // Each element: (label, backup_src_dir, restore_dst_dir)
    //
    // "OneDrive" is handled specially: when KFM (Known Folder Move) was active
    // on the source machine, standard folders like Documents/Desktop/Pictures
    // were redirected inside OneDrive during backup. We detect this by looking
    // for those folder names inside backup/OneDrive/ that are NOT also present
    // as top-level backup keys (which would mean they were backed up separately).
    // Matched KFM folders are redirected to target_root\{folder} so that Windows
    // libraries work correctly. Non-standard OneDrive subdirs go to
    // target_root\OneDrive\{name} as normal.
    let mut sources: Vec<(String, PathBuf, PathBuf)> = Vec::new();

    for key in &manifest.folders_included {
        if key == "OneDrive" {
            let od_src = PathBuf::from(&options.backup_path).join("OneDrive");
            if !od_src.exists() {
                warn!("backup folder 'OneDrive' not found at {} — skipping", od_src.display());
                continue;
            }
            // Expand OneDrive into per-subfolder entries so KFM folders can be
            // remapped individually to their standard profile locations.
            match std::fs::read_dir(&od_src) {
                Ok(entries) => {
                    let mut expanded = 0usize;
                    for entry in entries.filter_map(|e| e.ok()) {
                        let Ok(ft) = entry.file_type() else { continue };
                        if !ft.is_dir() { continue; }
                        let name = entry.file_name().to_string_lossy().to_string();
                        let src_sub = od_src.join(&name);
                        // A subfolder is a KFM-redirected folder if its name matches a
                        // standard folder AND it is not already present as its own
                        // top-level backup key (which would mean it was backed up directly).
                        let is_kfm = STANDARD_FOLDERS.iter().any(|&f| f.eq_ignore_ascii_case(&name))
                            && !manifest.folders_included.iter().any(|k| k.eq_ignore_ascii_case(&name));
                        let dst_sub = if is_kfm {
                            info!("KFM remap: OneDrive/{} → {}", name, target_root.join(&name).display());
                            target_root.join(&name)
                        } else {
                            target_root.join("OneDrive").join(&name)
                        };
                        sources.push((format!("OneDrive/{name}"), src_sub, dst_sub));
                        expanded += 1;
                    }
                    if expanded == 0 {
                        // OneDrive folder exists but has no subdirectories — restore as-is.
                        info!("OneDrive folder has no subdirs; restoring as-is");
                        sources.push(("OneDrive".to_string(), od_src, target_root.join("OneDrive")));
                    } else {
                        info!("OneDrive: expanded into {} subfolder mappings", expanded);
                    }
                }
                Err(e) => {
                    warn!("cannot read OneDrive backup dir {}: {}", od_src.display(), e);
                }
            }
        } else {
            let src = PathBuf::from(&options.backup_path).join(key);
            if !src.exists() {
                warn!("backup folder '{}' not found at {} — skipping", key, src.display());
                continue;
            }
            let dst = target_root.join(restore_subdir(key));
            sources.push((key.clone(), src, dst));
        }
    }

    if sources.is_empty() {
        return Err("No restorable folders found in the backup directory.".to_string());
    }

    // ── Pre-scan ───────────────────────────────────────────────────────────────

    let scan_dirs: Vec<(String, PathBuf)> = sources
        .iter()
        .map(|(k, src, _)| (k.clone(), src.clone()))
        .collect();

    let (total_files, total_bytes) =
        tauri::async_runtime::spawn_blocking(move || count_all(&scan_dirs))
            .await
            .map_err(|e| format!("Pre-scan task failed: {e}"))?;

    info!("Pre-scan: {} files, {} bytes", total_files, total_bytes);

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
        operation: Some("restore".to_string()),
    };
    emit(&app, &prog);

    let mut ctrl = ctrl_rx;
    let mut error_log: Vec<String> = Vec::new();

    // ── Copy loop ──────────────────────────────────────────────────────────────

    for (key, src_root, dst_root) in &sources {
        info!("restoring '{}': {} → {}", key, src_root.display(), dst_root.display());

        let src_clone = src_root.clone();
        let file_entries = tauri::async_runtime::spawn_blocking(move || {
            walkdir::WalkDir::new(&src_clone)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .map(|e| {
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    (e.path().to_path_buf(), size)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("Directory scan failed for '{}': {e}", key))?;

        for (src_path, file_size) in file_entries {
            // ── Pause / cancel check ───────────────────────────────────────────
            match check_engine(&mut ctrl, &mut prog, &app).await {
                EngineAction::Cancel(_) => {
                    // Restore never deletes — we never remove a user's profile.
                    prog.is_running = false;
                    prog.operation = None;
                    emit(&app, &prog);
                    info!("restore cancelled by user");
                    return Ok(());
                }
                EngineAction::Continue => {}
            }

            // ── Compute destination path ───────────────────────────────────────
            let rel = match src_path.strip_prefix(src_root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            let dst_path = dst_root.join(&rel);

            let file_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            prog.current_file = if options.dry_run {
                format!("[TEST] {}", file_name)
            } else {
                file_name
            };
            prog.file_progress = 0.0;
            emit(&app, &prog);

            if options.dry_run {
                // ── Dry run: advance counters without touching the filesystem ──
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
                // ── Ensure destination parent directory exists ─────────────────
                if let Some(parent) = dst_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        error!("mkdir {}: {}", parent.display(), e);
                        prog.error_count += 1;
                        error_log.push(format!("{}: {}", src_path.display(), e));
                        continue;
                    }
                }

                // ── Copy with progress ─────────────────────────────────────────
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

    // ── Write error log (skipped in dry run) ──────────────────────────────────

    if !error_log.is_empty() && !options.dry_run {
        let log_path = PathBuf::from(&options.backup_path).join("restore_errors.log");
        let content = error_log.join("\n");
        if let Err(e) = tokio::fs::write(&log_path, &content).await {
            error!("write restore_errors.log: {}", e);
        } else {
            info!("{} errors → {}", error_log.len(), log_path.display());
        }
    }

    if options.dry_run {
        info!(
            "[DRY RUN] complete — {} files, {} bytes (nothing written)",
            prog.files_copied, prog.bytes_copied
        );
    } else {
        info!(
            "restore complete: {} files, {} bytes, {} errors",
            prog.files_copied, prog.bytes_copied, prog.error_count
        );
    }

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

// ── Drive restore engine ──────────────────────────────────────────────────────

/// Restores standard user folders directly from an external drive profile
/// (no manifest required). Copies Desktop, Documents, Downloads, Pictures,
/// Music, Videos, Favorites, and any OneDrive folder found in the source.
pub async fn run_drive_restore(
    options: DriveRestoreOptions,
    app: tauri::AppHandle,
    ctrl_rx: watch::Receiver<EngineCmd>,
) -> Result<(), String> {
    info!(
        "run_drive_restore: source='{}' target='{}'",
        options.source_profile_path, options.target_username
    );

    let src_root = PathBuf::from(&options.source_profile_path);
    let target_root = PathBuf::from(format!("C:\\Users\\{}", options.target_username));

    // ── Build sources from what actually exists in the source profile ──────────

    let mut sources: Vec<(String, PathBuf, PathBuf)> = STANDARD_FOLDERS
        .iter()
        .filter_map(|&folder| {
            let src = src_root.join(folder);
            if src.exists() {
                let dst = target_root.join(folder);
                info!("drive restore: queuing '{}' → {}", folder, dst.display());
                Some((folder.to_string(), src, dst))
            } else {
                None
            }
        })
        .collect();

    // Also include any OneDrive folder present in the profile root.
    if let Some(od_path) = find_onedrive_in_profile(&src_root) {
        let od_name = od_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("OneDrive")
            .to_string();
        let dst = target_root.join(&od_name);
        info!("drive restore: queuing OneDrive '{}' → {}", od_path.display(), dst.display());
        sources.push((od_name, od_path, dst));
    }

    if sources.is_empty() {
        return Err("No standard folders found in the source profile.".to_string());
    }

    // ── Pre-scan ───────────────────────────────────────────────────────────────

    let scan_dirs: Vec<(String, PathBuf)> = sources
        .iter()
        .map(|(k, src, _)| (k.clone(), src.clone()))
        .collect();

    let (total_files, total_bytes) =
        tauri::async_runtime::spawn_blocking(move || count_all(&scan_dirs))
            .await
            .map_err(|e| format!("Pre-scan task failed: {e}"))?;

    info!("Pre-scan: {} files, {} bytes", total_files, total_bytes);

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
        operation: Some("restore".to_string()),
    };
    emit(&app, &prog);

    let mut ctrl = ctrl_rx;
    let mut error_log: Vec<String> = Vec::new();

    // ── Copy loop ──────────────────────────────────────────────────────────────

    for (key, src_dir, dst_dir) in &sources {
        info!("copying '{}': {} → {}", key, src_dir.display(), dst_dir.display());

        let src_clone = src_dir.clone();
        let file_entries = tauri::async_runtime::spawn_blocking(move || {
            walkdir::WalkDir::new(&src_clone)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .map(|e| {
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    (e.path().to_path_buf(), size)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("Directory scan failed for '{}': {e}", key))?;

        for (src_path, file_size) in file_entries {
            match check_engine(&mut ctrl, &mut prog, &app).await {
                EngineAction::Cancel(_) => {
                    prog.is_running = false;
                    prog.operation = None;
                    emit(&app, &prog);
                    info!("drive restore cancelled by user");
                    return Ok(());
                }
                EngineAction::Continue => {}
            }

            let rel = match src_path.strip_prefix(src_dir) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            let dst_path = dst_dir.join(&rel);

            let file_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            prog.current_file = if options.dry_run {
                format!("[TEST] {}", file_name)
            } else {
                file_name
            };
            prog.file_progress = 0.0;
            emit(&app, &prog);

            if options.dry_run {
                // ── Dry run: advance counters without touching the filesystem ──
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

    // ── Write error log (skipped in dry run) ──────────────────────────────────

    if !error_log.is_empty() && !options.dry_run {
        let log_path = target_root.join("drive_restore_errors.log");
        let content = error_log.join("\n");
        if let Err(e) = tokio::fs::write(&log_path, &content).await {
            error!("write drive_restore_errors.log: {}", e);
        } else {
            info!("{} errors → {}", error_log.len(), log_path.display());
        }
    }

    if options.dry_run {
        info!(
            "[DRY RUN] complete — {} files, {} bytes (nothing written)",
            prog.files_copied, prog.bytes_copied
        );
    } else {
        info!(
            "drive restore complete: {} files, {} bytes, {} errors",
            prog.files_copied, prog.bytes_copied, prog.error_count
        );
    }

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

/// Scans the given profile directory for any folder whose name starts with
/// "onedrive" (case-insensitive). Skips symlinks and junctions.
fn find_onedrive_in_profile(profile: &PathBuf) -> Option<PathBuf> {
    let entries = std::fs::read_dir(profile).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.to_ascii_lowercase().starts_with("onedrive") {
            return Some(entry.path());
        }
    }
    None
}

// ── Manifest reader ───────────────────────────────────────────────────────────

/// Reads and parses manifest.json from a backup folder synchronously.
/// Used internally by the restore engine to discover which folders were backed up.
pub fn read_manifest_file(backup_path: &str) -> Result<BackupManifest, String> {
    let path = PathBuf::from(backup_path).join("manifest.json");
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;
    serde_json::from_str(&json)
        .map_err(|e| format!("Invalid manifest.json: {}", e))
}

// ── Path mapping ──────────────────────────────────────────────────────────────

/// Maps a backup folder key back to the actual profile subdirectory.
/// Delegates to the shared mapping in backup.rs.
fn restore_subdir(key: &str) -> &str {
    profile_subdir(key)
}
