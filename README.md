# Pete the Computer Geek — Backup Tool

A Windows profile backup and restore tool built for technicians. Copies user data — documents, desktop, pictures, browser bookmarks, Outlook mail stores — from any source profile to a destination folder or directly into another Windows user account. Handles OneDrive Known Folder Move (KFM) transparently so files always land in the right place after a restore.

**Version:** 0.1.0
**Platform:** Windows 10 1709+ / Windows 11
**Built with:** Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS v3

---

## Requirements

| Requirement | Details |
|---|---|
| **Administrator** | The app must run as Administrator to read other users' profile folders (e.g. `C:\Users\OtherUser`). A warning banner appears at the top of the Backup and Restore tabs if admin rights are not detected. Install using the NSIS perMachine installer to get a UAC-elevated launch. |
| **Windows 10/11** | Designed and tested on Windows 10 1709+ and Windows 11. OneDrive Files-On-Demand placeholder detection requires Windows 10 1709 or later. |

---

## Backup Tab

Copies a source Windows user profile to a destination folder on any drive. A `manifest.json` file is written alongside the backup so the Restore tab can read all metadata (date, file count, folders, source computer) without opening the backup folder.

| Option | Details |
|---|---|
| **Source User** | Pick any local Windows profile found under `C:\Users\`. The list shows each account's display name, SID, and total profile size. System accounts (Default, Public, All Users) are excluded. |
| **External Drive** | Switch to "External Drive" mode to browse a drive or folder and scan profiles from an old PC's pulled hard disk. |
| **Destination** | The folder where the backup will be created. A subfolder named after the source username is appended automatically — just point at the root of your external drive or network share. |
| **Folders Included** | Standard shell folders are always included: Desktop, Documents, Downloads, Pictures, Music, Videos, and Favorites. Their real paths are read from the Windows registry (Shell Folders key) so renamed or relocated folders are handled correctly. |
| **Extra Folders** | Any non-standard folder found in the profile root is listed with its size. Check any you want to include — for example a custom `Projects\` or `Saved Games\` folder. |
| **Browser Data** | Detected browsers are listed based on whether their AppData folder exists. Only bookmark files are copied — not cache, history, cookies, or passwords. |
| **Email Data** | Outlook `.pst` files and Thunderbird profiles are detected and shown as optional toggles. |
| **QuickBooks Data** | If QuickBooks company files (`.QBW`) are detected in the user's Documents or at `C:\Users\Public\Documents\Intuit\`, they are surfaced here. Files in Documents are included automatically; the shared Intuit folder requires the toggle to be enabled. |
| **Direct Restore Mode** | Instead of writing to a backup folder, copies the source profile directly into an existing local user account. Useful for in-place migrations on the same machine. No manifest is written. |
| **Dry Run** | Scans and logs every file that would be copied without writing anything to disk. Use this to verify the source, check file count and size, and confirm paths before committing. Full output appears in the Logs tab. |

### OneDrive & KFM

If the source user has OneDrive **Known Folder Move** active, standard folders (Documents, Desktop, Pictures, etc.) are stored inside the OneDrive folder rather than their default locations. The backup engine detects this via the registry and backs up the entire OneDrive root as a single source, skipping the shell folder symlinks to avoid duplicating files.

> **Cloud-only placeholders are skipped.** OneDrive Files-On-Demand files that haven't been downloaded locally show as 0-byte placeholder stubs on disk. The backup engine detects these via Windows file attributes (`RECALL_ON_DATA_ACCESS`, `RECALL_ON_OPEN`, `OFFLINE`) and skips them with a `[CLOUD]` warning in the log. Only files that are fully local are backed up.

---

## Restore Tab

Restores files from an external drive into a local Windows user profile. The tool scans every connected drive (A–Z, except C:) automatically on load and groups restore sources by drive letter.

| Source Type | Details |
|---|---|
| **Managed** | A backup folder created by this tool. Contains a `manifest.json` with the original username, source computer, date, total file count, folder list, and OneDrive path. Shown with a blue "Managed" badge. Selecting one expands a detail card with all metadata. |
| **Unmanaged** | A raw Windows user profile found under a `\Users\` directory on the external drive — typically from a pulled hard disk. No manifest is available. The tool copies standard folders (Desktop, Documents, etc.) and any OneDrive folder it finds. Shown with an amber "Unmanaged" badge. |
| **Restore Into** | The local Windows user account to restore files into. Files are written directly to that profile's folder under `C:\Users\{username}`. The target user does not need to be logged in. |
| **Dry Run** | Logs every file that would be written without touching the filesystem. The Start button label changes to "Test Run" when dry run is active. |

### OneDrive KFM During Restore

If the backup was taken from a machine where KFM was active, standard folders (Documents, Desktop, Pictures, etc.) will be inside the backup's `OneDrive\` subfolder. The restore engine detects this automatically: any standard folder found directly inside `backup\OneDrive\` is redirected to its standard profile location (e.g. `C:\Users\NewUser\Documents`), so Windows libraries show the files correctly without requiring OneDrive to be set up on the new machine. Non-standard OneDrive subfolders go to `C:\Users\NewUser\OneDrive\` as normal.

---

## App Data

For browsers, only bookmark-related files are copied — no cache, history, cookies, sessions, or passwords. This keeps backup size small and avoids copying data that would be invalid on a new machine.

| App | What's Backed Up |
|---|---|
| **Chrome** | `Default\Bookmarks` and `Default\Bookmarks.bak` from the Chrome User Data folder. |
| **Edge** | `Default\Bookmarks` and `Default\Bookmarks.bak` from the Edge User Data folder. |
| **Brave** | `Default\Bookmarks` and `Default\Bookmarks.bak` from the Brave User Data folder. |
| **Opera** | `Default\Bookmarks` and `Default\Bookmarks.bak` from the Opera User Data folder. |
| **Firefox** | All files inside the `bookmarkbackups\` subfolder of the Firefox profile (dated JSON bookmark snapshot files). |
| **Outlook** | Only `.pst` files (Personal Storage Table — mail, contacts, calendar). OST files (offline cache) are excluded as they are regenerated automatically by Outlook. |
| **Thunderbird** | The full Thunderbird profiles folder, excluding regenerable cache directories: `cache2\`, `startupCache\`, and `OfflineCache\`. |
| **QuickBooks** | `.QBW` company files saved inside the user profile (Documents, Desktop, etc.) are covered automatically. If data also exists at `C:\Users\Public\Documents\Intuit\` (the installer default shared location), the Backup tab surfaces a toggle to include it. |

---

## Logs Tab

| | |
|---|---|
| **Log file** | `%APPDATA%\com.pete.ptcg-backup-tool\logs\ptcg-backup-tool.log` |
| **Log level** | Debug and above — all info, warnings, and errors from the backup and restore engines are captured. Cloud placeholder skips appear as `[CLOUD]` warnings. Dry run file listings appear as `[DRY RUN]` info entries. |
| **In-app viewer** | Reads the last 64 KB of the log file. Older entries are trimmed with an "earlier entries omitted" notice. Click "Open Log File" to open the full log in your default text editor. |
| **Error logs** | If a backup or restore encounters per-file errors, a separate `errors.log` or `restore_errors.log` is written inside the backup folder itself for easy reference alongside the backup data. |

---

## License

MIT License — Copyright (c) 2025 Pete the Computer Geek
