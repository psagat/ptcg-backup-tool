import { useEffect, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, Button, CheckboxRow, SectionLabel, Input, Badge, EmptyState } from '../components/ui';
import UserList from '../components/UserList';
import { getLocalUsers, getExternalUsers, scanExternalSources, detectBitlockerDrives, startBackup, browseFolder, checkAdmin, detectBrowsers, detectOneDrive, detectExtraFolders, detectQuickbooks, openFolder, createDir } from '../lib/tauri';
import BitLockerDialog from '../components/BitLockerDialog';
import type { WindowsUser, ProgressState, BrowserToggles, ExtraFolder, QuickbooksInfo } from '../types';

const INCLUDED_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'Favorites', 'Saved Games'];

const BROWSER_ROWS: { key: keyof BrowserToggles; label: string }[] = [
  { key: 'chrome',  label: 'Google Chrome' },
  { key: 'edge',    label: 'Microsoft Edge' },
  { key: 'brave',   label: 'Brave' },
  { key: 'firefox', label: 'Mozilla Firefox' },
  { key: 'opera',   label: 'Opera' },
];

const EMAIL_ROWS: { key: keyof BrowserToggles; label: string }[] = [
  { key: 'outlook',     label: 'Microsoft Outlook (PST files)' },
  { key: 'thunderbird', label: 'Thunderbird' },
];

const EMPTY_BROWSERS: BrowserToggles = { chrome: false, firefox: false, edge: false, opera: false, brave: false, outlook: false, thunderbird: false };

interface BackupTabProps {
  progress: ProgressState;
}

export default function BackupTab({ progress }: BackupTabProps) {
  const [users, setUsers] = useState<WindowsUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [selectedUser, setSelectedUser] = useState<WindowsUser | null>(null);

  type SourceMode = 'local' | 'external' | 'browse';
  const [sourceMode, setSourceMode] = useState<SourceMode>('local');
  const [browsePath, setBrowsePath] = useState('');
  const [loadingExternal, setLoadingExternal] = useState(false);
  const [lockedDrives, setLockedDrives] = useState<string[]>([]);
  const [unlockTarget, setUnlockTarget] = useState<string | null>(null);

  // browsers: only detected ones are shown; all detected are enabled by default
  const [browsers, setBrowsers] = useState<BrowserToggles>(EMPTY_BROWSERS);
  const [detectedBrowsers, setDetectedBrowsers] = useState<string[]>([]);
  const [detectingBrowsers, setDetectingBrowsers] = useState(false);

  // OneDrive root path if detected for the selected profile
  const [oneDriveRoot, setOneDriveRoot] = useState<string | null>(null);

  // extra folders: user-created folders found in the profile root
  const [extraFolders, setExtraFolders] = useState<ExtraFolder[]>([]);
  const [selectedExtraFolders, setSelectedExtraFolders] = useState<Set<string>>(new Set());
  const [detectingExtraFolders, setDetectingExtraFolders] = useState(false);

  // QuickBooks: checked per-profile (Documents scan + system-wide Public path)
  const [quickbooks, setQuickbooks] = useState<QuickbooksInfo | null>(null);
  const [includeQuickbooks, setIncludeQuickbooks] = useState(false);

  const [dryRun, setDryRun] = useState(false);

  // Destination: folder or direct-restore-to-user
  const [directRestore, setDirectRestore] = useState(false);
  const [baseFolderPath, setBaseFolderPath] = useState('');   // raw browsed folder
  const [destinationPath, setDestinationPath] = useState(''); // full path shown in input
  const [targetUser, setTargetUser] = useState<WindowsUser | null>(null);
  const [localUsersForTarget, setLocalUsersForTarget] = useState<WindowsUser[]>([]);
  const [loadingTargetUsers, setLoadingTargetUsers] = useState(false);

  const isRunning = progress.isRunning;
  const scanToken = useRef(0);

  useEffect(() => {
    checkAdmin().then(setIsAdmin);
    loadLocalUsers();
  }, []);

  function loadLocalUsers() {
    const token = ++scanToken.current;
    setLoadingUsers(true);
    setLoadingExternal(false);
    setLoadError('');
    getLocalUsers()
      .then((result) => { if (scanToken.current === token) setUsers(result); })
      .catch((e: unknown) => {
        if (scanToken.current !== token) return;
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
        console.error('getLocalUsers failed:', e);
      })
      .finally(() => { if (scanToken.current === token) setLoadingUsers(false); });
  }

  function clearSourceUser() {
    setSelectedUser(null);
    setDetectedBrowsers([]);
    setBrowsers(EMPTY_BROWSERS);
    setOneDriveRoot(null);
    setExtraFolders([]);
    setSelectedExtraFolders(new Set());
    setQuickbooks(null);
    setIncludeQuickbooks(false);
  }

  /** Called whenever the user picks a source profile. */
  function handleUserSelect(user: WindowsUser) {
    setSelectedUser(user);

    // Auto-fill destination with the user's name appended to any already-browsed base folder,
    // and pre-create it so it shows up the next time they open the folder browser.
    if (baseFolderPath) {
      const full = `${baseFolderPath}\\${user.username}`;
      setDestinationPath(full);
      createDir(full).catch(console.error);
    }

    // Reset per-profile detections before starting new scans.
    setOneDriveRoot(null);
    setExtraFolders([]);
    setSelectedExtraFolders(new Set());
    setQuickbooks(null);
    setIncludeQuickbooks(false);

    detectOneDrive(user.sid, user.profilePath)
      .then(setOneDriveRoot)
      .catch(console.error);

    // Detect browsers and extra folders in parallel.
    setDetectingBrowsers(true);
    detectBrowsers(user.profilePath)
      .then((found) => {
        setDetectedBrowsers(found);
        setBrowsers({
          chrome:      found.includes('chrome'),
          edge:        found.includes('edge'),
          brave:       found.includes('brave'),
          firefox:     found.includes('firefox'),
          opera:       found.includes('opera'),
          outlook:     found.includes('outlook'),
          thunderbird: found.includes('thunderbird'),
        });
      })
      .catch(console.error)
      .finally(() => setDetectingBrowsers(false));

    setDetectingExtraFolders(true);
    detectExtraFolders(user.profilePath)
      .then(setExtraFolders)
      .catch(console.error)
      .finally(() => setDetectingExtraFolders(false));

    detectQuickbooks(user.profilePath)
      .then(setQuickbooks)
      .catch(console.error);
  }

  function loadExternalProfiles() {
    const token = ++scanToken.current;
    setLoadingExternal(true);
    setLoadingUsers(false);
    setUsers([]);
    clearSourceUser();
    setLoadError('');
    setLockedDrives([]);
    // Profile scan and BitLocker detection run independently so profiles
    // always appear even if BitLocker detection takes extra time.
    scanExternalSources()
      .then((sources) => {
        if (scanToken.current !== token) return;
        const profiles = sources
          .filter((s) => s.kind === 'profile')
          .map((s) => (s as Extract<typeof s, { kind: 'profile' }>).user);
        setUsers(profiles);
      })
      .catch((e: unknown) => {
        if (scanToken.current !== token) return;
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
      })
      .finally(() => { if (scanToken.current === token) setLoadingExternal(false); });
    detectBitlockerDrives()
      .then((drives) => { if (scanToken.current === token) setLockedDrives(drives); })
      .catch(console.error);
  }

  async function handleBrowse() {
    const path = await browseFolder('Select folder containing user profiles');
    if (!path) return; // user cancelled — don't change anything
    const token = ++scanToken.current;
    setSourceMode('browse');
    setBrowsePath(path);
    setLoadingExternal(true);
    setLoadingUsers(false);
    setUsers([]);
    clearSourceUser();
    setLoadError('');
    getExternalUsers(path)
      .then((result) => { if (scanToken.current === token) setUsers(result); })
      .catch((e: unknown) => {
        if (scanToken.current !== token) return;
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
        console.error('getExternalUsers failed:', e);
      })
      .finally(() => { if (scanToken.current === token) setLoadingExternal(false); });
  }

  async function handleBrowseDestination() {
    const path = await browseFolder('Select backup location');
    if (!path) return;
    // Strip any trailing backslashes the dialog may return (e.g. "C:\" → "C:").
    const base = path.replace(/\\+$/, '');
    setBaseFolderPath(base);
    if (selectedUser) {
      const full = `${base}\\${selectedUser.username}`;
      setDestinationPath(full);
      // Pre-create the folder so it's visible next time the browser opens.
      createDir(full).catch(console.error);
    } else {
      setDestinationPath(path);
    }
  }

  function handleDirectRestoreToggle(enabled: boolean) {
    setDirectRestore(enabled);
    setTargetUser(null);
    if (enabled && localUsersForTarget.length === 0) {
      setLoadingTargetUsers(true);
      getLocalUsers()
        .then(setLocalUsersForTarget)
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          setLoadError(msg);
          console.error('getLocalUsers (target) failed:', e);
        })
        .finally(() => setLoadingTargetUsers(false));
    }
  }

  async function handleStart() {
    if (!selectedUser) return;
    if (directRestore && !targetUser) return;
    if (!directRestore && !destinationPath) return;

    const includeBrowsers = (Object.keys(browsers) as (keyof BrowserToggles)[])
      .filter((k) => browsers[k]);

    await startBackup({
      sourcePath: selectedUser.profilePath,
      destinationPath: directRestore ? '' : destinationPath,
      sid: selectedUser.sid,
      includeBrowsers,
      directRestore,
      targetSid: directRestore ? targetUser!.sid : undefined,
      targetUsername: directRestore ? targetUser!.username : undefined,
      dryRun,
      extraFolders: [
        ...Array.from(selectedExtraFolders),
        ...(includeQuickbooks && quickbooks?.publicPath ? [quickbooks.publicPath] : []),
      ],
    });
  }

  const canStart = !!selectedUser && (directRestore ? !!targetUser : !!destinationPath) && !isRunning;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Admin warning banner */}
      {isAdmin === false && (
        <div className="flex-none flex items-center gap-3 px-5 py-2.5 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-300 text-xs">
          <span className="text-yellow-400 text-base leading-none">⚠</span>
          <span>
            <strong>Not running as Administrator.</strong>
            {' '}Profile scanning and file access will fail.
            Restart the app from an Administrator terminal:{' '}
            <span className="font-mono bg-yellow-500/10 px-1 py-0.5 rounded">npm run tauri dev</span>
          </span>
        </div>
      )}

      <div className="flex-1 p-5 grid grid-cols-[1fr_320px] gap-4 overflow-hidden">
      {/* Left column — source */}
      <div className="overflow-y-auto scrollbar-thin space-y-4 pr-1">
        {/* Source profile */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Source Profile</CardTitle>
              {selectedUser && (
                <Badge variant="info">{selectedUser.username}</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {/* Source mode toggle */}
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setSourceMode('local'); setUsers([]); clearSourceUser(); loadLocalUsers(); }}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${sourceMode === 'local' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-white/10 text-white/40 hover:text-white/70'}`}
                >
                  This PC
                </button>
                <button
                  onClick={() => { setSourceMode('external'); loadExternalProfiles(); }}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${sourceMode === 'external' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-white/10 text-white/40 hover:text-white/70'}`}
                >
                  External Drive
                </button>
                <button
                  onClick={handleBrowse}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${sourceMode === 'browse' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-white/10 text-white/40 hover:text-white/70'}`}
                >
                  Browse
                </button>
              </div>
              {sourceMode === 'browse' && browsePath && (
                <p className="text-xs text-white/35 font-mono mt-1.5 truncate">{browsePath}</p>
              )}
            </div>

            {loadError && (
              <div className="mb-3 text-xs bg-red-500/10 border border-red-500/20 text-red-400 rounded-md px-3 py-2 font-mono">
                <span className="font-sans font-semibold block mb-0.5">Failed to scan profiles</span>
                {loadError}
                <button
                  className="block mt-1 text-red-300/70 hover:text-red-300 underline font-sans"
                  onClick={loadLocalUsers}
                >
                  Retry
                </button>
              </div>
            )}

            {sourceMode === 'browse' && !browsePath ? (
              <EmptyState
                message="No folder selected"
                sub="Click Browse to open a folder containing user profiles"
              />
            ) : (
              <>
                <UserList
                  users={users}
                  selectedSid={selectedUser?.sid ?? null}
                  onSelect={handleUserSelect}
                  onDeselect={clearSourceUser}
                  loading={loadingUsers || loadingExternal}
                  emptySub={
                    sourceMode === 'external'
                      ? lockedDrives.length > 0
                        ? 'Unlock the drive below to scan its profiles.'
                        : 'No external drives with user profiles were found.'
                      : 'Run as Administrator to read all profiles.'
                  }
                />
                {/* BitLocker-locked drives notice */}
                {sourceMode === 'external' && !loadingExternal && lockedDrives.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {lockedDrives.map((drive) => (
                      <div
                        key={drive}
                        className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-amber-500/8 border border-amber-500/20"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-amber-400 flex-none">🔒</span>
                          <span className="text-xs text-amber-300/80">
                            Drive <span className="font-mono">{drive}</span> is BitLocker-encrypted
                          </span>
                        </div>
                        <button
                          onClick={() => setUnlockTarget(drive)}
                          className="flex-none text-xs px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
                        >
                          Unlock
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Folders included */}
        <Card>
          <CardHeader>
            <CardTitle>Folders Included</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div className="flex flex-wrap gap-1.5">
              {INCLUDED_FOLDERS.map((folder) => (
                <span
                  key={folder}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-white/5 text-white/60 border border-white/8"
                >
                  <span className="text-green-400/80">✓</span> {folder}
                </span>
              ))}
              {oneDriveRoot && (
                <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-300/80 border border-blue-500/20">
                  <span className="text-green-400/80">✓</span> OneDrive
                </span>
              )}
            </div>
            <p className="text-xs text-white/30 mt-3">
              AppData is excluded except for browser bookmarks and email data that is selected.
            </p>
          </CardContent>
        </Card>
        {/* Additional folders */}
        {selectedUser && (
          <Card>
            <CardHeader>
              <CardTitle>Additional Folders</CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {detectingExtraFolders ? (
                <div className="py-3 space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-8 rounded-md bg-white/5 animate-pulse" />
                  ))}
                </div>
              ) : extraFolders.length === 0 ? (
                <p className="text-xs text-white/30 px-2 py-3">No additional folders found in this profile.</p>
              ) : (
                <>
                  <p className="text-xs text-white/30 px-2 pb-2">
                    Click a folder name to open it in Explorer.
                  </p>
                  {extraFolders.map((folder) => (
                    <div
                      key={folder.path}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/3"
                    >
                      <button
                        onClick={() => setSelectedExtraFolders((prev) => {
                          const next = new Set(prev);
                          if (next.has(folder.path)) next.delete(folder.path);
                          else next.add(folder.path);
                          return next;
                        })}
                        className={`flex-none w-4 h-4 rounded border flex items-center justify-center text-xs transition-colors ${
                          selectedExtraFolders.has(folder.path)
                            ? 'bg-accent/30 border-accent/60 text-accent'
                            : 'border-white/20 hover:border-white/40'
                        }`}
                      >
                        {selectedExtraFolders.has(folder.path) && '✓'}
                      </button>
                      <button
                        onClick={() => openFolder(folder.path)}
                        title={folder.path}
                        className="flex-1 text-xs text-left text-white/70 hover:text-accent truncate"
                      >
                        {folder.name}
                      </button>
                      <span className="text-xs font-mono text-white/35 flex-none">{folder.sizeFormatted}</span>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Right column — options */}
      <div className="overflow-y-auto scrollbar-thin space-y-4">
        {/* Browser bookmarks */}
        <Card>
          <CardHeader>
            <CardTitle>Browser Bookmarks</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {detectingBrowsers ? (
              <div className="py-3 space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="h-8 rounded-md bg-white/5 animate-pulse" />
                ))}
              </div>
            ) : detectedBrowsers.length === 0 ? (
              <p className="text-xs text-white/30 px-2 py-3">
                {selectedUser
                  ? 'No supported browsers found in this profile.'
                  : 'Select a profile to see available browsers.'}
              </p>
            ) : (
              BROWSER_ROWS.filter((b) => detectedBrowsers.includes(b.key)).map(({ key, label }) => (
                <CheckboxRow
                  key={key}
                  label={label}
                  checked={browsers[key]}
                  onChange={(v) => setBrowsers((b) => ({ ...b, [key]: v }))}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Email data */}
        <Card>
          <CardHeader>
            <CardTitle>Email Data</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {detectingBrowsers ? (
              <div className="py-3 space-y-2">
                {[1].map((i) => (
                  <div key={i} className="h-8 rounded-md bg-white/5 animate-pulse" />
                ))}
              </div>
            ) : EMAIL_ROWS.filter((r) => detectedBrowsers.includes(r.key)).length === 0 ? (
              <p className="text-xs text-white/30 px-2 py-3">
                {selectedUser
                  ? 'No Outlook PST files or Thunderbird profiles found.'
                  : 'Select a profile to see email data.'}
              </p>
            ) : (
              EMAIL_ROWS.filter((r) => detectedBrowsers.includes(r.key)).map(({ key, label }) => (
                <CheckboxRow
                  key={key}
                  label={label}
                  checked={browsers[key]}
                  onChange={(v) => setBrowsers((b) => ({ ...b, [key]: v }))}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* QuickBooks data */}
        {selectedUser && (
          <Card>
            <CardHeader>
              <CardTitle>QuickBooks Data</CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {!quickbooks ? (
                <div className="py-3 space-y-2">
                  <div className="h-8 rounded-md bg-white/5 animate-pulse" />
                </div>
              ) : (
                <>
                  {quickbooks.publicPath && (
                    <CheckboxRow
                      label="Intuit / QuickBooks (Shared)"
                      description={quickbooks.publicPath}
                      checked={includeQuickbooks}
                      onChange={setIncludeQuickbooks}
                    />
                  )}
                  {quickbooks.documentsFiles.length > 0 && (
                    <div className="px-3 py-2">
                      <p className="text-xs text-white/50 mb-1">
                        Found in Documents <span className="text-green-400/70">(included automatically)</span>
                      </p>
                      <ul className="space-y-0.5">
                        {quickbooks.documentsFiles.map((f) => (
                          <li key={f} className="text-xs font-mono text-white/40">{f}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!quickbooks.publicPath && quickbooks.documentsFiles.length === 0 && (
                    <p className="text-xs text-white/30 px-2 py-3">
                      No QuickBooks company files found. Files in Documents or Desktop are included automatically.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Destination */}
        <Card>
          <CardHeader>
            <CardTitle>Destination</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Mode toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => handleDirectRestoreToggle(false)}
                disabled={isRunning}
                className={`flex-1 text-xs px-3 py-1.5 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  !directRestore
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-white/10 text-white/40 hover:text-white/70'
                }`}
              >
                Save to Folder
              </button>
              <button
                onClick={() => handleDirectRestoreToggle(true)}
                disabled={isRunning}
                className={`flex-1 text-xs px-3 py-1.5 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  directRestore
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-white/10 text-white/40 hover:text-white/70'
                }`}
              >
                Restore to User
              </button>
            </div>

            {!directRestore ? (
              <div>
                <SectionLabel>Backup folder</SectionLabel>
                <div className="flex gap-2">
                  <Input
                    value={destinationPath}
                    onChange={(e) => setDestinationPath(e.target.value)}
                    placeholder="C:\Backups\..."
                  />
                  <Button variant="secondary" size="md" onClick={handleBrowseDestination}>
                    Browse
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <SectionLabel>
                  Target user on this PC
                  {targetUser && (
                    <span className="ml-2 text-accent">— {targetUser.username}</span>
                  )}
                </SectionLabel>
                <UserList
                  users={localUsersForTarget}
                  selectedSid={targetUser?.sid ?? null}
                  onSelect={setTargetUser}
                  onDeselect={() => setTargetUser(null)}
                  loading={loadingTargetUsers}
                />
                <p className="text-xs text-white/30 mt-2">
                  Files will be copied directly into this user's profile.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dry run toggle */}
        <button
          onClick={() => setDryRun((v) => !v)}
          disabled={isRunning}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            dryRun
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              : 'bg-white/3 border-white/8 text-white/50 hover:text-white/70'
          }`}
        >
          <span className={`flex-none w-4 h-4 rounded border flex items-center justify-center text-xs ${
            dryRun ? 'bg-amber-500/30 border-amber-400/60 text-amber-300' : 'border-white/20'
          }`}>
            {dryRun && '✓'}
          </span>
          <span className="text-xs">
            <span className="font-semibold">Dry Run</span>
            <span className="text-white/40 ml-1">— scan &amp; log only, nothing written</span>
          </span>
        </button>

        {/* Start */}
        <Button
          variant={dryRun ? 'secondary' : 'primary'}
          size="lg"
          className="w-full"
          disabled={!canStart}
          onClick={handleStart}
        >
          {dryRun
            ? 'Test Run'
            : directRestore
            ? 'Restore Directly'
            : 'Start Backup'}
        </Button>

        {!selectedUser && (
          <p className="text-xs text-white/30 text-center">Select a source profile to continue</p>
        )}
        {selectedUser && !directRestore && !destinationPath && (
          <p className="text-xs text-white/30 text-center">Select a destination folder to continue</p>
        )}
        {selectedUser && directRestore && !targetUser && (
          <p className="text-xs text-white/30 text-center">Select a target user to continue</p>
        )}
      </div>
      </div>

      {/* BitLocker unlock dialog */}
      {unlockTarget && (
        <BitLockerDialog
          drive={unlockTarget}
          onUnlocked={() => {
            setUnlockTarget(null);
            loadExternalProfiles();
          }}
          onClose={() => setUnlockTarget(null)}
        />
      )}
    </div>
  );
}
