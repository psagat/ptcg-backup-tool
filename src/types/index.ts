export interface ExtraFolder {
  name: string;
  path: string;
  sizeBytes: number;
  sizeFormatted: string;
}

export interface WindowsUser {
  username: string;
  displayName: string;
  sid: string;
  profilePath: string;
  totalSizeBytes: number;
  totalSizeFormatted: string;
  isActive: boolean;
}

export interface ProgressState {
  isRunning: boolean;
  isPaused: boolean;
  currentFile: string;
  fileProgress: number;    // 0–100
  overallProgress: number; // 0–100
  filesCopied: number;
  totalFiles: number;
  bytesCopied: number;
  totalBytes: number;
  errorCount: number;
  operation: 'backup' | 'restore' | null;
}

export type ExternalSource =
  | { kind: 'backup'; drive: string; path: string; manifest: BackupManifest }
  | { kind: 'profile'; drive: string; user: WindowsUser };

export interface BackupManifest {
  username: string;
  sid: string;
  timestamp: string;
  sourceComputer: string;
  totalFiles: number;
  totalSizeBytes: number;
  foldersIncluded: string[];
  browsersIncluded: string[];
  oneDrivePath?: string;
}

export interface BackupOptions {
  sourcePath: string;
  destinationPath: string;
  sid: string;
  includeBrowsers: string[];
  directRestore: boolean;
  targetSid?: string;
  targetUsername?: string;
  dryRun: boolean;
  extraFolders: string[];
}

export interface RestoreOptions {
  backupPath: string;
  targetSid: string;
  targetUsername: string;
  dryRun: boolean;
}

export interface DriveRestoreOptions {
  sourceProfilePath: string;
  targetUsername: string;
  dryRun: boolean;
}

export interface QuickbooksInfo {
  /** Path to C:\Users\Public\Documents\Intuit if found — not covered by profile backup. */
  publicPath: string | null;
  /** .QBW filenames found in the user's Documents folder — already covered by backup. */
  documentsFiles: string[];
}

export type BrowserKey = 'chrome' | 'firefox' | 'edge' | 'opera' | 'brave' | 'outlook' | 'thunderbird';

export interface BrowserToggles {
  chrome: boolean;
  firefox: boolean;
  edge: boolean;
  opera: boolean;
  brave: boolean;
  outlook: boolean;
  thunderbird: boolean;
}
