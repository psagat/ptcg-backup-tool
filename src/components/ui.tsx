import { forwardRef } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ── Utility ──────────────────────────────────────────────────────────────────

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Button ───────────────────────────────────────────────────────────────────

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'destructive' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className, children, ...props }, ref) => {
    const variantClass = {
      primary: 'bg-accent hover:bg-accent-hover text-white',
      secondary: 'bg-elevated hover:bg-white/10 text-white border border-white/10',
      destructive: 'bg-red-600/90 hover:bg-red-600 text-white',
      ghost: 'hover:bg-white/5 text-white/60 hover:text-white',
    }[variant];

    const sizeClass = {
      sm: 'px-3 py-1.5 text-xs gap-1.5 h-7',
      md: 'px-4 py-2 text-sm gap-2 h-9',
      lg: 'px-5 py-2.5 text-sm gap-2 h-10',
    }[size];

    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center font-medium rounded-md transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
          variantClass,
          sizeClass,
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

// ── Card ─────────────────────────────────────────────────────────────────────

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
}

export function Card({ elevated = false, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-white/5',
        elevated ? 'bg-elevated' : 'bg-surface',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-4 py-3 border-b border-white/5', className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-semibold text-white/90 tracking-wide uppercase', className)} {...props}>
      {children}
    </h3>
  );
}

export function CardContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('p-4', className)} {...props}>
      {children}
    </div>
  );
}

// ── Toggle ───────────────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, disabled = false }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        checked ? 'bg-accent' : 'bg-white/15',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-1',
        )}
      />
    </button>
  );
}

// ── CheckboxRow ──────────────────────────────────────────────────────────────

interface CheckboxRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function CheckboxRow({ label, description, checked, onChange, disabled = false }: CheckboxRowProps) {
  return (
    <label
      className={cn(
        'flex items-center justify-between gap-4 py-2.5 px-3 rounded-md cursor-pointer',
        'hover:bg-white/3 transition-colors',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <div className="min-w-0">
        <span className="text-sm text-white/90">{label}</span>
        {description && (
          <p className="text-xs text-white/40 mt-0.5">{description}</p>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

// ── Badge ────────────────────────────────────────────────────────────────────

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
}

export function Badge({ variant = 'default', className, children, ...props }: BadgeProps) {
  const variantClass = {
    default: 'bg-white/10 text-white/60',
    success: 'bg-green-500/15 text-green-400',
    warning: 'bg-yellow-500/15 text-yellow-400',
    error: 'bg-red-500/15 text-red-400',
    info: 'bg-accent/15 text-accent',
  }[variant];

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
        variantClass,
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

// ── Separator ────────────────────────────────────────────────────────────────

export function Separator({ className }: { className?: string }) {
  return <div className={cn('border-t border-white/5', className)} />;
}

// ── Input ────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full h-9 bg-elevated border border-white/10 rounded-md px-3 text-sm text-white',
        'font-mono placeholder:text-white/25 placeholder:font-sans',
        'focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/30',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        'transition-colors',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

// ── SectionLabel ─────────────────────────────────────────────────────────────

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('text-xs font-semibold text-white/40 uppercase tracking-widest mb-2', className)}>
      {children}
    </p>
  );
}

// ── EmptyState ───────────────────────────────────────────────────────────────

export function EmptyState({ message, sub }: { message: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
      <p className="text-sm text-white/40">{message}</p>
      {sub && <p className="text-xs text-white/25">{sub}</p>}
    </div>
  );
}
