import { useState } from 'react';
import { Button, Input } from './ui';
import { unlockBitlockerDrive } from '../lib/tauri';

interface BitLockerDialogProps {
  drive: string;       // e.g. "E:"
  onUnlocked: () => void;
  onClose: () => void;
}

export default function BitLockerDialog({ drive, onUnlocked, onClose }: BitLockerDialogProps) {
  const [keyType, setKeyType] = useState<'recovery' | 'password'>('recovery');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  async function handleUnlock() {
    if (!key.trim()) return;
    setUnlocking(true);
    setError('');
    try {
      await unlockBitlockerDrive(drive, key.trim(), keyType);
      onUnlocked();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-white/10 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white mb-1">BitLocker Drive Locked</h2>
        <p className="text-sm text-white/50 mb-5">
          Drive <span className="font-mono text-white/75">{drive}</span> is BitLocker-encrypted.
          Enter the key to unlock it, then the scan will continue automatically.
        </p>

        {/* Key type toggle */}
        <div className="flex gap-2 mb-4">
          {(['recovery', 'password'] as const).map((type) => (
            <button
              key={type}
              onClick={() => { setKeyType(type); setKey(''); setError(''); }}
              className={`flex-1 text-xs px-3 py-2 rounded-md border transition-colors ${
                keyType === type
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-white/10 text-white/40 hover:text-white/70'
              }`}
            >
              {type === 'recovery' ? 'Recovery Key' : 'Password'}
            </button>
          ))}
        </div>

        {/* Key input */}
        <Input
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(''); }}
          placeholder={
            keyType === 'recovery'
              ? '000000-000000-000000-000000-000000-000000-000000-000000'
              : 'BitLocker password'
          }
          type={keyType === 'password' ? 'password' : 'text'}
          className="font-mono mb-3"
          onKeyDown={(e) => e.key === 'Enter' && !unlocking && handleUnlock()}
          autoFocus
        />

        {/* Recovery key hint */}
        {keyType === 'recovery' && (
          <p className="text-xs text-white/30 mb-4 leading-relaxed">
            The 48-digit recovery key can be found at{' '}
            <span className="font-mono text-white/45">account.microsoft.com/devices/recoverykey</span>
            {' '}if the original PC was signed in to a Microsoft account. It may also be saved
            on a USB drive or printed.
          </p>
        )}

        {keyType === 'password' && (
          <p className="text-xs text-white/30 mb-4 leading-relaxed">
            This is the password set when BitLocker was turned on. Note: if the drive was
            protected by TPM on the original PC (no password was set), use the Recovery Key instead.
          </p>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400 font-mono">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" size="md" onClick={onClose} disabled={unlocking}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleUnlock}
            disabled={!key.trim() || unlocking}
          >
            {unlocking ? 'Unlocking…' : 'Unlock Drive'}
          </Button>
        </div>
      </div>
    </div>
  );
}
