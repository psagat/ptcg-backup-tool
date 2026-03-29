import { cn, Badge, EmptyState } from './ui';
import type { WindowsUser } from '../types';

interface UserListProps {
  users: WindowsUser[];
  selectedSid: string | null;
  onSelect: (user: WindowsUser) => void;
  onDeselect?: () => void;
  loading?: boolean;
  emptyMessage?: string;
}

export default function UserList({
  users,
  selectedSid,
  onSelect,
  onDeselect,
  loading = false,
  emptyMessage = 'No user profiles found.',
}: UserListProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-white/35 px-1 pb-1 flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-white/20 border-t-white/60 animate-spin" />
          Scanning profiles…
        </p>
        {[1, 2].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-elevated/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (users.length === 0) {
    return <EmptyState message={emptyMessage} sub="Run as Administrator to read all profiles." />;
  }

  return (
    <div className="space-y-1.5">
      {users.map((user) => {
        const isSelected = user.sid === selectedSid;
        return (
          <button
            key={user.sid}
            onClick={() => isSelected && onDeselect ? onDeselect() : onSelect(user)}
            className={cn(
              'w-full text-left rounded-lg border px-4 py-3 transition-all',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              isSelected
                ? 'bg-accent/10 border-accent/40 ring-1 ring-accent/20'
                : 'bg-elevated border-white/5 hover:border-white/15 hover:bg-white/3',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{user.displayName || user.username}</span>
                  {user.isActive && (
                    <Badge variant="success">Active</Badge>
                  )}
                </div>
                <p className="text-xs text-white/40 font-mono mt-0.5 truncate">{user.profilePath}</p>
              </div>
              <div className="text-right flex-none">
                <span className="text-sm font-mono text-white/70">{user.totalSizeFormatted}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
