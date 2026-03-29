# Changelog

## [1.1.0] — 2026-03-29

### Added

- **BitLocker in-app unlock** — If an external drive is BitLocker-encrypted, an amber notice appears in the Source Profile card with an Unlock button. Entering a Recovery Key (48-digit) or Password unlocks the drive via `manage-bde` without leaving the app; the profile scan re-runs automatically.
- **External drive auto-scan** — "External Drive" mode now scans all connected drive letters (A–Z except C:) automatically and lists every profile found, instead of requiring a manual folder browse.
- **Browse button** — A third source mode button opens a folder picker immediately on click (no secondary button). Mode only changes if a folder is actually selected; cancelling leaves the current view unchanged.
- **QuickBooks detection** — When a source profile is selected, the app scans for `.QBW` company files in the user's Documents folder (shown as already included) and in `C:\Users\Public\Documents\Intuit\` (shown as an optional toggle).

### Fixed

- **BitLocker drives not detected** — `Path::exists()` calls `GetFileAttributesW`, which returns false for BitLocker-locked volumes because the filesystem is not mounted. Drive enumeration now uses `GetLogicalDrives()` (Win32 API), which operates at the partition-manager level and correctly reports locked volumes — the same way Windows Explorer does.
- **BitLocker error code** — The Windows error surfaced for BitLocker-locked `read_dir` calls is an HRESULT with the FVE facility (`0x8031xxxx`), not the Win32 `ERROR_DRIVE_LOCKED` (6800). Detection now checks the FVE facility bits so it works regardless of the specific sub-code returned.
- **External users all appearing selected** — When scanning a pulled drive (no registry available), the SID fallback was `"unknown"` for every profile, causing `user.sid === selectedSid` to match all of them simultaneously. The fallback is now the profile path, which is unique per user.
- **Stale scan results on mode switch** — Switching source modes (This PC → External Drive → This PC) while a scan was in progress could show results from the wrong scan. A token counter now discards results from any scan that is no longer the active one.
- **Spinner stuck after mode switch** — Each load function now resets the other mode's loading flag on start, so `loading={loadingUsers || loadingExternal}` can never be held true by a stale flag from a cancelled scan.
- **Misleading "Run as Administrator" message** — The empty-state sub-message in the profile list was always "Run as Administrator to read all profiles." regardless of context. It now shows "Unlock the drive below to scan its profiles." when a BitLocker drive is detected, and "No external drives with user profiles were found." otherwise.

### Changed

- "Browser Data" section in the About tab renamed to **App Data** to reflect that it also covers Outlook, Thunderbird, and QuickBooks — not just browsers.

---

## [1.0.0] — Initial release

- Full backup and restore workflow for Windows user profiles
- Managed (manifest-based) and unmanaged (raw profile) restore sources
- OneDrive Known Folder Move detection and transparent restore
- Browser bookmark backup (Chrome, Edge, Brave, Firefox, Opera)
- Email data backup (Outlook PST, Thunderbird profiles)
- Direct user-to-user restore mode
- Dry run / test mode
- In-app log viewer
- NSIS per-machine installer with UAC elevation
