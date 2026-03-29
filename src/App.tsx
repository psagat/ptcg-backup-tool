import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import BackupTab from './pages/BackupTab';
import RestoreTab from './pages/RestoreTab';
import LogTab from './pages/LogTab';
import AboutTab from './pages/AboutTab';
import ProgressPanel from './components/ProgressPanel';
import CancelDialog from './components/CancelDialog';
import { cancelOperation, pauseOperation, resumeOperation } from './lib/tauri';
import type { ProgressState } from './types';
import logo from './assets/logo.ico';

type Tab = 'backup' | 'restore' | 'logs' | 'about';

const INITIAL_PROGRESS: ProgressState = {
  isRunning: false,
  isPaused: false,
  currentFile: '',
  fileProgress: 0,
  overallProgress: 0,
  filesCopied: 0,
  totalFiles: 0,
  bytesCopied: 0,
  totalBytes: 0,
  errorCount: 0,
  operation: null,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('backup');
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);

  // Tracks whether the last event had isRunning=true so we can detect completion.
  const wasRunningRef = useRef(false);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<ProgressState>('progress', (event) => {
      const p = event.payload;

      if (wasRunningRef.current && !p.isRunning) {
        // Transition from running → stopped.
        // Only show a completion banner for natural finishes (not cancel/error).
        const isNormalCompletion =
          p.currentFile === 'Complete' || p.currentFile === 'Dry Run Complete';

        if (isNormalCompletion) {
          const isDryRun = p.currentFile === 'Dry Run Complete';
          const msg = isDryRun
            ? `Dry run complete — ${p.filesCopied.toLocaleString()} files scanned, nothing written.`
            : p.errorCount > 0
            ? `Complete with ${p.errorCount} error${p.errorCount !== 1 ? 's' : ''} — open the log for details.`
            : `Complete — ${p.filesCopied.toLocaleString()} files.`;

          clearTimeout(completionTimerRef.current);
          setCompletionMessage(msg);
        }

        // Always reset to initial state when the operation ends so the UI is
        // ready for the next operation (mode toggles, Browse button, etc.).
        setProgress(INITIAL_PROGRESS);
      } else {
        setProgress(p);
      }

      wasRunningRef.current = p.isRunning;
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
      clearTimeout(completionTimerRef.current);
    };
  }, []);

  async function handleCancelClick() {
    await pauseOperation();
    setShowCancelDialog(true);
  }

  async function handleDismissCancel() {
    setShowCancelDialog(false);
    await resumeOperation();
  }

  async function handleCancelKeep() {
    setShowCancelDialog(false);
    await cancelOperation(false);
    setProgress(INITIAL_PROGRESS);
  }

  async function handleCancelDelete() {
    setShowCancelDialog(false);
    await cancelOperation(true);
    setProgress(INITIAL_PROGRESS);
  }

  const tabs: { id: Tab; label: string; alwaysEnabled?: boolean }[] = [
    { id: 'backup', label: 'Backup' },
    { id: 'restore', label: 'Restore' },
    { id: 'logs', label: 'Logs', alwaysEnabled: true },
    { id: 'about', label: 'About', alwaysEnabled: true },
  ];

  return (
    <div className="h-screen flex flex-col bg-bg text-white font-sans overflow-hidden">
      {/* Header */}
      <header className="flex-none bg-surface border-b border-white/5 px-6 pt-4 pb-0">
        <div className="flex items-end gap-6">
          <h1 className="text-sm font-semibold text-white/50 tracking-widest uppercase pb-3">
            Pete the Computer Geek Backup Tool
          </h1>

          <nav className="flex gap-0.5">
            {tabs.map(({ id, label, alwaysEnabled }) => (
              <button
                key={id}
                onClick={() => (!progress.isRunning || alwaysEnabled) && setActiveTab(id)}
                className={`
                  px-5 py-2.5 text-sm font-medium rounded-t-lg transition-all border-t border-x
                  ${activeTab === id
                    ? 'bg-bg text-white border-white/8 -mb-px relative z-10'
                    : 'text-white/35 hover:text-white/60 border-transparent'
                  }
                  ${progress.isRunning && !alwaysEnabled && activeTab !== id ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}
                `}
              >
                {label}
              </button>
            ))}
          </nav>

          <img src={logo} alt="Pete the Computer Geek" className="ml-auto mb-2 h-10 w-10 object-contain" />
        </div>
      </header>

      {/* Completion banner — shown briefly after an operation finishes */}
      {completionMessage && (
        <div className="flex-none flex items-center gap-3 px-5 py-2.5 bg-green-500/10 border-b border-green-500/20 text-green-300 text-xs">
          <span className="text-green-400 text-base leading-none">✓</span>
          <span>{completionMessage}</span>
          <button
            onClick={() => setCompletionMessage(null)}
            className="ml-auto text-green-400/40 hover:text-green-300"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tab content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === 'backup' ? (
          <BackupTab progress={progress} />
        ) : activeTab === 'restore' ? (
          <RestoreTab progress={progress} />
        ) : activeTab === 'logs' ? (
          <LogTab progress={progress} />
        ) : (
          <AboutTab />
        )}
      </main>

      {/* Slide-up progress panel */}
      {progress.isRunning && (
        <ProgressPanel
          progress={progress}
          onCancelClick={handleCancelClick}
        />
      )}

      {/* Cancel confirmation dialog */}
      {showCancelDialog && (
        <CancelDialog
          operation={progress.operation}
          onKeep={handleCancelKeep}
          onDelete={handleCancelDelete}
          isDryRun={progress.currentFile.startsWith('[TEST]')}
          onDismiss={handleDismissCancel}
        />
      )}
    </div>
  );
}
