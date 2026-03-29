import { Button } from './ui';

interface CancelDialogProps {
  operation: 'backup' | 'restore' | null;
  isDryRun: boolean;
  onKeep: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

export default function CancelDialog({ operation, isDryRun, onKeep, onDelete, onDismiss }: CancelDialogProps) {
  const label = operation === 'restore' ? 'restore' : 'backup';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onDismiss}
    >
      <div
        className="bg-surface border border-white/10 rounded-xl shadow-2xl w-full max-w-sm p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white mb-1">Cancel {label}?</h2>
        <p className="text-sm text-white/50 mb-6">
          {isDryRun
            ? 'This is a dry run — no files have been written.'
            : `The operation is not complete. What should happen to the partial ${label}?`}
        </p>

        <div className="space-y-2">
          <Button
            variant="secondary"
            className="w-full justify-start text-left"
            onClick={onKeep}
          >
            <span className="text-white/80">{isDryRun ? `Stop ${label}` : `Keep partial ${label}`}</span>
          </Button>
          {!isDryRun && (
            <Button
              variant="destructive"
              className="w-full justify-start text-left"
              onClick={onDelete}
            >
              Delete partial {label}
            </Button>
          )}
        </div>

        <button
          className="mt-4 w-full text-center text-xs text-white/30 hover:text-white/60 transition-colors py-1"
          onClick={onDismiss}
        >
          Go back (don't cancel)
        </button>
      </div>
    </div>
  );
}
