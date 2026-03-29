import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { WindowsUser, BackupManifest, BackupOptions, RestoreOptions, DriveRestoreOptions, ExtraFolder, ExternalSource, QuickbooksInfo } from '../types';

const isTauri = () => '__TAURI_INTERNALS__' in window;

// ── Mock data for browser-only dev ──────────────────────────────────────────

const MOCK_USERS: WindowsUser[] = [
  {
    username: 'Pete',
    displayName: 'Pete',
    sid: 'S-1-5-21-mock-1000',
    profilePath: 'C:\\Users\\Pete',
    totalSizeBytes: 45_000_000_000,
    totalSizeFormatted: '41.9 GB',
    isActive: true,
  },
  {
    username: 'OldUser',
    displayName: 'OldUser',
    sid: 'S-1-5-21-mock-1001',
    profilePath: 'C:\\Users\\OldUser',
    totalSizeBytes: 12_300_000_000,
    totalSizeFormatted: '11.5 GB',
    isActive: false,
  },
];

// ── Admin check ──────────────────────────────────────────────────────────────

/** Returns true if the process has Administrator privileges. */
export async function checkAdmin(): Promise<boolean> {
  if (!isTauri()) return true; // assume admin in browser dev
  return invoke<boolean>('check_admin');
}

// ── User commands ────────────────────────────────────────────────────────────

export async function getLocalUsers(): Promise<WindowsUser[]> {
  if (!isTauri()) return MOCK_USERS;
  return invoke<WindowsUser[]>('get_local_users');
}

export async function getExternalUsers(drivePath: string): Promise<WindowsUser[]> {
  if (!isTauri()) return MOCK_USERS;
  return invoke<WindowsUser[]>('get_external_users', { drivePath });
}

/** Scans all drive letters (A–Z except C:) for backups (manifest.json) and pulled-drive profiles. */
export async function scanExternalSources(): Promise<ExternalSource[]> {
  if (!isTauri()) return [];
  return invoke<ExternalSource[]>('scan_external_sources');
}

/** Returns browser keys ('chrome', 'edge', 'firefox', 'opera') whose AppData folders exist. */
export async function detectBrowsers(profilePath: string): Promise<string[]> {
  if (!isTauri()) return ['chrome', 'edge'];
  return invoke<string[]>('detect_browsers', { profilePath });
}

/** Returns the OneDrive root path for the user, or null if not configured. */
export async function detectOneDrive(sid: string, profilePath: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('detect_onedrive', { sid, profilePath });
}

/** Returns extra folders in the profile root not covered by the standard backup set. */
export async function detectExtraFolders(profilePath: string): Promise<ExtraFolder[]> {
  if (!isTauri()) return [];
  return invoke<ExtraFolder[]>('detect_extra_folders', { profilePath });
}

/** Returns drive letters (e.g. ["E:", "F:"]) that are BitLocker-locked. */
export async function detectBitlockerDrives(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('detect_bitlocker_drives');
}

/** Attempts to unlock a BitLocker drive. Throws on failure with the error message from manage-bde. */
export async function unlockBitlockerDrive(drive: string, key: string, keyType: 'password' | 'recovery'): Promise<void> {
  if (!isTauri()) return;
  return invoke('unlock_bitlocker_drive', { drive, key, keyType });
}

/** Checks for QuickBooks files at the shared Intuit location and in the user's Documents. */
export async function detectQuickbooks(profilePath: string): Promise<QuickbooksInfo> {
  if (!isTauri()) return { publicPath: null, documentsFiles: [] };
  return invoke<QuickbooksInfo>('detect_quickbooks', { profilePath });
}

/** Opens the given folder path in Windows Explorer. */
export async function openFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('open_folder', { path });
}

// ── Operation commands ───────────────────────────────────────────────────────

export async function startBackup(options: BackupOptions): Promise<void> {
  if (!isTauri()) return;
  return invoke('start_backup', { options });
}

export async function startRestore(options: RestoreOptions): Promise<void> {
  if (!isTauri()) return;
  return invoke('start_restore', { options });
}

export async function startDriveRestore(options: DriveRestoreOptions): Promise<void> {
  if (!isTauri()) return;
  return invoke('start_drive_restore', { options });
}

export async function pauseOperation(): Promise<void> {
  if (!isTauri()) return;
  return invoke('pause_operation');
}

export async function resumeOperation(): Promise<void> {
  if (!isTauri()) return;
  return invoke('resume_operation');
}

export async function cancelOperation(deletePartial: boolean): Promise<void> {
  if (!isTauri()) return;
  return invoke('cancel_operation', { deletePartial });
}

// ── Restore helpers ──────────────────────────────────────────────────────────

export async function readManifest(backupPath: string): Promise<BackupManifest> {
  if (!isTauri()) {
    return {
      username: 'Pete',
      sid: 'S-1-5-21-mock-1000',
      timestamp: new Date().toISOString(),
      sourceComputer: 'DESKTOP-MOCK',
      totalFiles: 15_234,
      totalSizeBytes: 45_000_000_000,
      foldersIncluded: ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'],
      browsersIncluded: ['Chrome'],
    };
  }
  return invoke<BackupManifest>('read_manifest', { backupPath });
}

export async function openLogFile(): Promise<void> {
  if (!isTauri()) return;
  return invoke('open_log_file');
}

/** Returns the tail of the application log file as a string (up to 64 KB). */
export async function readLogFile(): Promise<string> {
  if (!isTauri()) return '[Mock mode — no log file in browser dev]\n';
  return invoke<string>('read_log_file');
}

/** Creates a directory (and all parents). Used to pre-create the destination folder. */
export async function createDir(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('create_dir', { path });
}

// ── Dialog helpers ───────────────────────────────────────────────────────────

export async function browseFolder(title: string): Promise<string | null> {
  if (!isTauri()) return 'C:\\Users\\Pete\\Desktop\\backup-output';
  const result = await open({ directory: true, multiple: false, title });
  return typeof result === 'string' ? result : null;
}
