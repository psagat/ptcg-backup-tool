import { Button, cn } from './ui';
import { pauseOperation, resumeOperation } from '../lib/tauri';
import type { ProgressState } from '../types';

interface ProgressPanelProps {
  progress: ProgressState;
  onCancelClick: () => void;
}

function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 bg-white/10 rounded-full overflow-hidden', className)}>
      <div
        className="h-full bg-accent rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function ProgressPanel({ progress, onCancelClick }: ProgressPanelProps) {
  const { isPaused, currentFile, fileProgress, overallProgress, filesCopied, totalFiles, bytesCopied, totalBytes, errorCount, operation } = progress;

  async function handlePauseResume() {
    if (isPaused) {
      await resumeOperation();
    } else {
      await pauseOperation();
    }
  }

  return (
    <div className="flex-none border-t border-white/8 bg-surface px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {/* Animated indicator */}
          <span className="relative flex h-2 w-2">
            {!isPaused && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
            )}
            <span className={cn('relative inline-flex rounded-full h-2 w-2', isPaused ? 'bg-yellow-400' : 'bg-accent')} />
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
            {isPaused ? 'Paused' : operation === 'backup' ? 'Backing up' : 'Restoring'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-white/40 font-mono">
            {filesCopied} / {totalFiles} files &nbsp;·&nbsp; {formatBytes(bytesCopied)} / {formatBytes(totalBytes)}
          </span>
          {errorCount > 0 && (
            <span className="text-xs text-red-400 font-mono">{errorCount} errors</span>
          )}
          <Button size="sm" variant="ghost" onClick={handlePauseResume}>
            {isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="destructive" onClick={onCancelClick}>
            Cancel
          </Button>
        </div>
      </div>

      {/* Overall progress */}
      <div className="mb-2">
        <div className="flex justify-between text-xs text-white/40 mb-1">
          <span>Overall</span>
          <span className="font-mono">{overallProgress.toFixed(0)}%</span>
        </div>
        <ProgressBar value={overallProgress} />
      </div>

      {/* Current file */}
      <div>
        <div className="flex justify-between text-xs text-white/40 mb-1">
          <span className="truncate font-mono text-white/30 max-w-[80%]">{currentFile || '...'}</span>
          <span className="font-mono ml-2">{fileProgress.toFixed(0)}%</span>
        </div>
        <ProgressBar value={fileProgress} className="h-1" />
      </div>
    </div>
  );
}
