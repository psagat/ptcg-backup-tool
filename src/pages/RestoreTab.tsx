import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Separator } from '../components/ui';
import UserList from '../components/UserList';
import { getLocalUsers, scanExternalSources, startRestore, startDriveRestore } from '../lib/tauri';
import type { WindowsUser, ProgressState, ExternalSource } from '../types';

interface RestoreTabProps {
  progress: ProgressState;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Groups a flat source list by drive letter. */
function groupByDrive(sources: ExternalSource[]): Record<string, ExternalSource[]> {
  return sources.reduce<Record<string, ExternalSource[]>>((acc, src) => {
    (acc[src.drive] ??= []).push(src);
    return acc;
  }, {});
}

/** Stable key for comparing ExternalSource identity. */
function sourceKey(src: ExternalSource): string {
  return src.kind === 'backup' ? `backup:${src.path}` : `profile:${src.user.profilePath}`;
}

export default function RestoreTab({ progress }: RestoreTabProps) {
  const [sources, setSources]               = useState<ExternalSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedSource, setSelectedSource] = useState<ExternalSource | null>(null);

  const [users, setUsers]               = useState<WindowsUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedUser, setSelectedUser] = useState<WindowsUser | null>(null);

  const [dryRun, setDryRun] = useState(false);

  const isRunning = progress.isRunning;

  useEffect(() => {
    getLocalUsers()
      .then(setUsers)
      .catch(console.error)
      .finally(() => setLoadingUsers(false));
    scan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function scan() {
    setSources([]);
    setSelectedSource(null);
    setLoadingSources(true);
    scanExternalSources()
      .then(setSources)
      .catch(console.error)
      .finally(() => setLoadingSources(false));
  }

  async function handleStart() {
    if (!selectedSource || !selectedUser) return;
    if (selectedSource.kind === 'backup') {
      await startRestore({
        backupPath: selectedSource.path,
        targetSid: selectedUser.sid,
        targetUsername: selectedUser.username,
        dryRun,
      });
    } else {
      await startDriveRestore({
        sourceProfilePath: selectedSource.user.profilePath,
        targetUsername: selectedUser.username,
        dryRun,
      });
    }
  }

  const canStart = !isRunning && !!selectedSource && !!selectedUser;
  const sourceGroups = groupByDrive(sources);
  const selectedKey = selectedSource ? sourceKey(selectedSource) : null;

  return (
    <div className="p-5 space-y-4 overflow-y-auto scrollbar-thin h-full">

      {/* ── Restore Source ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Restore Source</CardTitle>
            <Button variant="secondary" size="sm" onClick={scan} disabled={loadingSources}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingSources && (
            <div className="space-y-2">
              <div className="h-14 rounded-lg bg-elevated/60 animate-pulse" />
              <div className="h-14 rounded-lg bg-elevated/60 animate-pulse" />
            </div>
          )}

          {!loadingSources && sources.length === 0 && (
            <p className="text-sm text-white/40 text-center py-6">
              No backups or drive profiles found.
              <br />
              <span className="text-xs text-white/25">Plug in the drive and click Refresh.</span>
            </p>
          )}

          {!loadingSources && Object.entries(sourceGroups).map(([drive, driveSources]) => (
            <div key={drive} className="mb-4 last:mb-0">
              <p className="text-xs text-white/40 font-mono mb-2">{drive}\</p>
              <div className="space-y-1">
                {driveSources.map((src) => {
                  const key = sourceKey(src);
                  const isSelected = selectedKey === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedSource(isSelected ? null : src)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                        isSelected
                          ? 'bg-accent/10 border-accent/30 text-white'
                          : 'bg-elevated/40 border-white/5 text-white/70 hover:bg-elevated/70 hover:text-white'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium truncate">
                            {src.kind === 'backup' ? src.manifest.username : src.user.username}
                          </span>
                          {src.kind === 'backup' ? (
                            <span className="relative group/tip">
                              <Badge variant="info">Managed</Badge>
                              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 rounded bg-surface border border-white/10 px-2.5 py-1.5 text-xs text-white/70 shadow-lg invisible group-hover/tip:visible z-20 whitespace-normal leading-snug">
                                Backed up with this tool — includes a full manifest with date, file count, and folder list.
                              </span>
                            </span>
                          ) : (
                            <span className="relative group/tip">
                              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">Unmanaged</span>
                              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 rounded bg-surface border border-white/10 px-2.5 py-1.5 text-xs text-white/70 shadow-lg invisible group-hover/tip:visible z-20 whitespace-normal leading-snug">
                                Raw Windows profile from a pulled drive — no backup manifest available.
                              </span>
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-white/40">
                          {src.kind === 'backup'
                            ? `${formatDate(src.manifest.timestamp)} · ${formatBytes(src.manifest.totalSizeBytes)}`
                            : src.user.totalSizeFormatted
                          }
                        </p>
                      </div>
                      {isSelected && <span className="text-accent text-sm">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Backup details (shown when a backup source is selected) ─────────── */}
      {selectedSource?.kind === 'backup' && (() => {
        const m = selectedSource.manifest;
        return (
          <Card>
            <CardHeader><CardTitle>Backup Details</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-white">{m.username}</span>
                <Badge variant="info">{m.sourceComputer}</Badge>
              </div>

              <Separator />

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <div>
                  <p className="text-white/40 mb-0.5">Date</p>
                  <p className="text-white/80 font-mono">{formatDate(m.timestamp)}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-0.5">Size</p>
                  <p className="text-white/80 font-mono">{formatBytes(m.totalSizeBytes)}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-0.5">Files</p>
                  <p className="text-white/80 font-mono">{m.totalFiles.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-0.5">SID</p>
                  <p className="text-white/30 font-mono truncate">{m.sid}</p>
                </div>
              </div>

              <Separator />

              <div>
                <p className="text-xs text-white/40 mb-1.5">Folders</p>
                <div className="flex flex-wrap gap-1">
                  {m.foldersIncluded.map((f) => (
                    <span key={f} className="text-xs px-2 py-0.5 bg-white/5 text-white/60 rounded">{f}</span>
                  ))}
                </div>
              </div>

              {m.browsersIncluded.length > 0 && (
                <div>
                  <p className="text-xs text-white/40 mb-1.5">Browser data</p>
                  <div className="flex flex-wrap gap-1">
                    {m.browsersIncluded.map((b) => (
                      <Badge key={b} variant="info">{b}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {m.oneDrivePath && (
                <div className="text-xs bg-accent/8 border border-accent/20 rounded-md px-3 py-2">
                  <span className="text-accent/80 font-medium">OneDrive detected</span>
                  <p className="text-white/40 font-mono mt-0.5 truncate">{m.oneDrivePath}</p>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* ── Restore Into ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Restore Into</CardTitle>
            {selectedUser && <Badge variant="info">{selectedUser.username}</Badge>}
          </div>
        </CardHeader>
        <CardContent>
          <UserList
            users={users}
            selectedSid={selectedUser?.sid ?? null}
            onSelect={setSelectedUser}
            onDeselect={() => setSelectedUser(null)}
            loading={loadingUsers}
            emptyMessage="No local user profiles found."
          />
        </CardContent>
      </Card>

      {/* ── Start button ────────────────────────────────────────────────────── */}
      <div className="pb-4">
        <button
          onClick={() => setDryRun((v) => !v)}
          disabled={isRunning}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-colors mb-2 disabled:opacity-40 disabled:cursor-not-allowed ${
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

        <Button
          variant={dryRun ? 'secondary' : 'primary'}
          size="lg"
          className="w-full"
          disabled={!canStart}
          onClick={handleStart}
        >
          {dryRun ? 'Test Run' : 'Start Restore'}
        </Button>

        {!selectedSource && (
          <p className="text-xs text-white/30 text-center mt-2">Select a restore source to continue</p>
        )}
        {selectedSource && !selectedUser && (
          <p className="text-xs text-white/30 text-center mt-2">Select a target user to continue</p>
        )}
      </div>
    </div>
  );
}
