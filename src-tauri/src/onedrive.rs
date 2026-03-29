// OneDrive / Shell Folder detection — Phase 6.
//
// Reads HKEY_USERS\<SID>\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders
// to determine if Documents / Pictures / etc. are redirected to OneDrive paths.
// Also checks HKEY_USERS\<SID>\SOFTWARE\Microsoft\OneDrive for the root path.
//
// "Shell Folders" (without "User") stores pre-expanded absolute paths, which is
// what we want when reading another user's hive via HKEY_USERS.

use log::warn;
use std::path::PathBuf;

// ── Types ──────────────────────────────────────────────────────────────────────

/// Resolved absolute paths for a user's well-known shell folders.
/// Fields may point into OneDrive when folder-redirection (Known Folder Move)
/// is active.
#[derive(Debug)]
pub struct UserFolderPaths {
    pub desktop: String,
    pub documents: String,
    pub downloads: String,
    pub pictures: String,
    pub music: String,
    pub videos: String,
    pub favorites: String,
    /// The OneDrive root folder, e.g. `C:\Users\Pete\OneDrive`, or `None`
    /// if OneDrive is not installed / configured for this user.
    pub one_drive_root: Option<String>,
}

// ── Public entry point ─────────────────────────────────────────────────────────

/// Returns resolved shell-folder paths for the given user.
///
/// On Windows the paths come from the registry; if the registry read fails
/// (or `sid` is empty / "unknown") we fall back to `{profile}\{folder}`.
/// On non-Windows platforms the function always returns default paths.
pub fn get_user_folder_paths(sid: &str, profile_path: &str) -> UserFolderPaths {
    #[cfg(windows)]
    {
        let mut paths = if sid.is_empty() || sid == "unknown" {
            warn!("Shell Folders: SID not available — using default paths");
            default_paths(profile_path)
        } else {
            get_from_registry(sid, profile_path)
        };

        // Filesystem fallback: if registry didn't find OneDrive (uninstalled,
        // external drive, enterprise config, etc.), scan the profile root.
        if paths.one_drive_root.is_none() {
            paths.one_drive_root = find_onedrive_dir(profile_path);
        }

        paths
    }

    #[cfg(not(windows))]
    {
        let _ = sid;
        default_paths(profile_path)
    }
}

// ── Windows registry implementation ───────────────────────────────────────────

#[cfg(windows)]
fn get_from_registry(sid: &str, profile_path: &str) -> UserFolderPaths {
    use winreg::enums::HKEY_USERS;
    use winreg::RegKey;

    let hku = RegKey::predef(HKEY_USERS);

    // ── Shell Folders ──────────────────────────────────────────────────────────
    // Pre-expanded absolute paths; suitable for reading another user's hive.

    let sf_key_path = format!(
        "{}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
        sid
    );

    let shell_folders = match hku.open_subkey(&sf_key_path) {
        Ok(k) => k,
        Err(e) => {
            warn!(
                "Shell Folders registry open failed for SID {}: {} — using default paths",
                sid, e
            );
            return default_paths(profile_path);
        }
    };

    // Helper: read a REG_SZ value, fall back to a default string on error.
    let read = |name: &str, default: &str| -> String {
        shell_folders
            .get_value::<String, _>(name)
            .unwrap_or_else(|_| default.to_string())
    };

    let p = profile_path;
    let desktop   = read("Desktop",                                 &format!("{}\\Desktop",   p));
    let documents = read("Personal",                                &format!("{}\\Documents", p));
    // Downloads uses a GUID — no legacy short name exists in Shell Folders.
    let downloads = read("{374DE290-123F-4565-9164-39C4925E467B}", &format!("{}\\Downloads", p));
    let pictures  = read("My Pictures",                             &format!("{}\\Pictures",  p));
    let music     = read("My Music",                                &format!("{}\\Music",     p));
    let videos    = read("My Video",                                &format!("{}\\Videos",    p));
    let favorites = read("Favorites",                               &format!("{}\\Favorites", p));

    // ── OneDrive root ──────────────────────────────────────────────────────────

    let one_drive_root = hku
        .open_subkey(format!("{}\\SOFTWARE\\Microsoft\\OneDrive", sid))
        .ok()
        .and_then(|k| k.get_value::<String, _>("UserFolder").ok())
        .filter(|v| !v.is_empty() && PathBuf::from(v).exists());

    if let Some(ref od) = one_drive_root {
        log::info!("OneDrive root detected for {}: {}", sid, od);
    }

    UserFolderPaths {
        desktop,
        documents,
        downloads,
        pictures,
        music,
        videos,
        favorites,
        one_drive_root,
    }
}

// ── Filesystem fallback ────────────────────────────────────────────────────────

/// Scans the profile root for any directory whose name starts with "OneDrive"
/// (case-insensitive). Handles cases where the folder exists but the registry
/// entry is absent: uninstalled OneDrive, external drives, enterprise configs.
fn find_onedrive_dir(profile_path: &str) -> Option<String> {
    let base = std::path::Path::new(profile_path);
    let entries = std::fs::read_dir(base).ok()?;
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
            let path = entry.path();
            log::info!("OneDrive dir found via filesystem fallback: {}", path.display());
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

// ── Fallback ───────────────────────────────────────────────────────────────────

fn default_paths(profile_path: &str) -> UserFolderPaths {
    let p = profile_path;
    UserFolderPaths {
        desktop:        format!("{}\\Desktop",   p),
        documents:      format!("{}\\Documents", p),
        downloads:      format!("{}\\Downloads", p),
        pictures:       format!("{}\\Pictures",  p),
        music:          format!("{}\\Music",     p),
        videos:         format!("{}\\Videos",    p),
        favorites:      format!("{}\\Favorites", p),
        one_drive_root: None,
    }
}
