import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui';
import { readLogFile, openLogFile } from '../lib/tauri';
import type { ProgressState } from '../types';

interface LogTabProps {
  progress: ProgressState;
}

/** Applies a colour class based on the log line content. */
function lineClass(line: string): string {
  if (line.includes('[ERROR]') || line.includes('ERROR'))  return 'text-red-400';
  if (line.includes('[WARN]')  || line.includes('WARN'))   return 'text-amber-400/80';
  if (line.includes('[DRY RUN]'))                          return 'text-amber-300/70';
  if (line.startsWith('[…'))                               return 'text-white/20 italic';
  return 'text-white/50';
}

export default function LogTab({ progress }: LogTabProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    setLoading(true);
    try {
      setContent(await readLogFile());
    } catch (e) {
      console.error('readLogFile:', e);
    } finally {
      setLoading(false);
    }
  }

  // Load on mount.
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every second while an operation is running.
  useEffect(() => {
    if (!progress.isRunning) return;
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [progress.isRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom whenever content changes.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content]);

  const lines = content.split('\n');

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex-none flex items-center justify-between px-5 py-2.5 border-b border-white/5 bg-surface">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-white/50">Application Log</p>
          {progress.isRunning && (
            <span className="flex items-center gap-1 text-xs text-accent/80">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setContent('')}>
            Clear
          </Button>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={openLogFile}>
            Open File
          </Button>
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto scrollbar-thin p-4 font-mono text-xs leading-relaxed"
      >
        {content === '' ? (
          <p className="text-white/25 text-center mt-10 text-sm font-sans">
            No log entries yet.
            <br />
            <span className="text-xs">Run a backup, restore, or dry run to see output here.</span>
          </p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line || '\u00A0'}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
