use std::path::Path;
use walkdir::WalkDir;
use serde::{Deserialize, Serialize};
use log::{info, warn, error};

use crate::backup::BackupManifest;

#[cfg(windows)]
use winreg::{enums::*, RegKey};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowsUser {
    pub username: String,
    pub display_name: String,
    pub sid: String,
    pub profile_path: String,
    pub total_size_bytes: u64,
    pub total_size_formatted: String,
    pub is_active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraFolder {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub size_formatted: String,
}

/// A restore source discovered on an external drive.
/// Either a backup made with this tool (has manifest.json) or a Windows user
/// profile on a drive pulled from an old PC.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExternalSource {
    #[serde(rename = "backup")]
    Backup {
        drive: String,
        path: String,
        manifest: BackupManifest,
    },
    #[serde(rename = "profile")]
    Profile {
        drive: String,
        user: WindowsUser,
    },
}

// Profile folder names that are not real users
const SKIP_NAMES: &[&str] = &[
    "Public",
    "Default",
    "Default User",
    "All Users",
    "defaultuser0",
    "defaultuser100000",
];

// ── Public API ───────────────────────────────────────────────────────────────

/// Scan C:\Users and return all real user profiles with sizes.
pub fn get_local_users() -> Vec<WindowsUser> {
    info!("Scanning local profiles: C:\\Users");
    let users = scan_users_dir(Path::new("C:\\Users"), true);
    info!("Found {} local user profiles", users.len());
    users
}

/// Scan <drive_path>\Users and return profiles from an external drive.
/// Registry is not read since it belongs to a different OS install.
pub fn get_external_users(drive_path: &str) -> Vec<WindowsUser> {
    let users_dir = Path::new(drive_path).join("Users");
    info!("Scanning external profiles: {}", users_dir.display());
    let users = scan_users_dir(&users_dir, false);
    info!("Found {} external user profiles", users.len());
    users
}

/// Scan every drive letter (A–Z, skipping C:) for restore sources:
/// - Backup folders: root-level directories that contain a manifest.json
///   written by this tool.
/// - User profiles: any \Users\ directory on a drive pulled from an old PC.
/// Both types are returned in a single list grouped by drive.
pub fn scan_external_sources() -> Vec<ExternalSource> {
    let mut results: Vec<ExternalSource> = Vec::new();

    for letter in b'A'..=b'Z' {
        if letter == b'C' { continue; }

        let drive_str  = format!("{}:\\", letter as char);
        let drive_root = Path::new(&drive_str);
        if !drive_root.exists() { continue; }

        let drive_label = format!("{}:", letter as char);

        // ── Backup folders: root-level dirs containing manifest.json ──────────
        if let Ok(entries) = std::fs::read_dir(drive_root) {
            for entry in entries.filter_map(|e| e.ok()) {
                let ft = match entry.file_type() { Ok(t) => t, Err(_) => continue };
                if !ft.is_dir() || ft.is_symlink() { continue; }

                let manifest_path = entry.path().join("manifest.json");
                if !manifest_path.exists() { continue; }

                match std::fs::read_to_string(&manifest_path) {
                    Ok(content) => match serde_json::from_str::<BackupManifest>(&content) {
                        Ok(manifest) => {
                            let path = entry.path().to_string_lossy().to_string();
                            info!("scan_external_sources: backup at {}", path);
                            results.push(ExternalSource::Backup { drive: drive_label.clone(), path, manifest });
                        }
                        Err(e) => warn!("scan_external_sources: bad manifest at {}: {}", manifest_path.display(), e),
                    },
                    Err(e) => warn!("scan_external_sources: cannot read {}: {}", manifest_path.display(), e),
                }
            }
        }

        // ── User profiles: \Users\ directory on a pulled drive ────────────────
        let users_dir = drive_root.join("Users");
        if users_dir.is_dir() {
            info!("scan_external_sources: \\Users found on {}", drive_label);
            let users = scan_users_dir(&users_dir, false);
            for user in users {
                results.push(ExternalSource::Profile { drive: drive_label.clone(), user });
            }
        }
    }

    info!("scan_external_sources: {} source(s) found", results.len());
    results
}

/// Scan a profile root for subdirectories not covered by the standard backup
/// folder set. Returns them sorted largest-first with sizes pre-calculated.
pub fn detect_extra_folders(profile_path: &str) -> Vec<ExtraFolder> {
    let base = Path::new(profile_path);
    let entries = match std::fs::read_dir(base) {
        Ok(e) => e,
        Err(e) => {
            warn!("detect_extra_folders: cannot read {}: {}", base.display(), e);
            return Vec::new();
        }
    };

    let mut folders: Vec<ExtraFolder> = entries
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => return None,
            };
            if !ft.is_dir() { return None; }
            // Skip junctions and symlinks — they are not real folders.
            if ft.is_symlink() { return None; }

            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => return None,
            };

            // Skip folders already covered by the standard backup set.
            if SKIP_EXTRA.iter().any(|&s| s.eq_ignore_ascii_case(&name)) {
                return None;
            }
            // Skip all OneDrive variants (e.g. "OneDrive - Personal", "OneDrive - Contoso").
            if name.to_ascii_lowercase().starts_with("onedrive") {
                return None;
            }

            let size_bytes = calculate_dir_size(&path);
            let size_formatted = format_bytes(size_bytes);
            Some(ExtraFolder { name, path: path.to_string_lossy().to_string(), size_bytes, size_formatted })
        })
        .collect();

    folders.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    info!("detect_extra_folders: {} extra folder(s) in {}", folders.len(), base.display());
    folders
}

/// Folders that are always included by the standard backup (or are system noise).
/// These are skipped when scanning for user-created extras.
const SKIP_EXTRA: &[&str] = &[
    // Already in the backup
    "Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos",
    "Favorites", "Saved Games",
    // AppData — handled selectively via browser/email options
    "AppData",
    // Windows system / typically-empty folders
    "3D Objects", "Contacts", "Links", "Searches", "MicrosoftEdgeBackups",
    // Legacy junction point names that may still appear in some Windows versions
    "Application Data", "Local Settings", "My Documents",
    "NetHood", "PrintHood", "Recent", "SendTo", "Start Menu", "Templates", "Cookies",
];

// ── Core scan logic ──────────────────────────────────────────────────────────

fn scan_users_dir(users_dir: &Path, read_registry: bool) -> Vec<WindowsUser> {
    // Build SID map from registry (local scans only)
    let sid_map = if read_registry {
        get_sid_map()
    } else {
        std::collections::HashMap::new()
    };

    let entries = match std::fs::read_dir(users_dir) {
        Ok(e) => e,
        Err(e) => {
            error!("Cannot read {}: {} — is the app running as Administrator?", users_dir.display(), e);
            return Vec::new();
        }
    };

    let mut users: Vec<WindowsUser> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|entry| {
            let path = entry.path();
            let username = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => return None,
            };

            if SKIP_NAMES.iter().any(|&s| s.eq_ignore_ascii_case(&username)) {
                return None;
            }

            let profile_path = path.to_string_lossy().to_string();
            // For local users: resolved from registry. For external drive users:
            // no registry is available, so use the profile path as a unique key.
            let sid = find_sid_for_path(&sid_map, &profile_path)
                .unwrap_or_else(|| profile_path.clone());

            // A profile is "active" if it has an NTUSER.DAT on the local machine.
            // External drive profiles always show as inactive — the hive belongs
            // to a different OS install so the badge would be meaningless.
            let is_active = read_registry && path.join("NTUSER.DAT").exists();

            info!("Calculating size for '{}' …", username);
            let total_size_bytes = calculate_dir_size(&path);
            let total_size_formatted = format_bytes(total_size_bytes);

            info!(
                "  {} — {} (SID: {})",
                username, total_size_formatted, sid
            );

            Some(WindowsUser {
                username: username.clone(),
                display_name: username,
                sid,
                profile_path,
                total_size_bytes,
                total_size_formatted,
                is_active,
            })
        })
        .collect();

    // Largest profiles first
    users.sort_by(|a, b| b.total_size_bytes.cmp(&a.total_size_bytes));
    users
}

// ── Registry helpers (Windows only) ─────────────────────────────────────────

#[cfg(windows)]
fn get_sid_map() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let profile_list = match hklm.open_subkey(
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList",
    ) {
        Ok(k) => k,
        Err(e) => {
            warn!("Cannot open ProfileList registry key: {}", e);
            return map;
        }
    };

    for sid in profile_list.enum_keys().flatten() {
        if let Ok(key) = profile_list.open_subkey(&sid) {
            if let Ok(raw_path) = key.get_value::<String, _>("ProfileImagePath") {
                let expanded = expand_env_str(&raw_path);
                map.insert(sid, expanded);
            }
        }
    }

    info!("Registry ProfileList: {} SID entries", map.len());
    map
}

#[cfg(not(windows))]
fn get_sid_map() -> std::collections::HashMap<String, String> {
    std::collections::HashMap::new()
}

fn find_sid_for_path(
    sid_map: &std::collections::HashMap<String, String>,
    profile_path: &str,
) -> Option<String> {
    let needle = profile_path.to_lowercase();
    sid_map
        .iter()
        .find_map(|(sid, reg_path)| {
            if reg_path.to_lowercase() == needle {
                Some(sid.clone())
            } else {
                None
            }
        })
}

/// Expand common environment variable tokens found in registry path values.
fn expand_env_str(s: &str) -> String {
    let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let sys_root  = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    s
        .replace("%SystemDrive%",  &sys_drive)
        .replace("%systemdrive%",  &sys_drive)
        .replace("%SystemRoot%",   &sys_root)
        .replace("%systemroot%",   &sys_root)
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

/// Walk a directory tree and sum file sizes.
/// Skips junctions, symlinks, and any paths that return permission errors.
fn calculate_dir_size(dir: &Path) -> u64 {
    WalkDir::new(dir)
        .follow_links(false) // never follow junctions or symlinks
        .into_iter()
        .filter_map(|entry| {
            match entry {
                Ok(e) => Some(e),
                Err(e) => {
                    // Permission denied, locked files, etc. — skip silently
                    warn!("Skipped: {}", e);
                    None
                }
            }
        })
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1_024;
    const MB: u64 = KB * 1_024;
    const GB: u64 = MB * 1_024;
    const TB: u64 = GB * 1_024;

    match bytes {
        b if b >= TB => format!("{:.2} TB", b as f64 / TB as f64),
        b if b >= GB => format!("{:.1} GB", b as f64 / GB as f64),
        b if b >= MB => format!("{:.0} MB", b as f64 / MB as f64),
        b if b >= KB => format!("{:.0} KB", b as f64 / KB as f64),
        b            => format!("{} B", b),
    }
}
