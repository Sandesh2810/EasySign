// Small shared UI pieces styled from the AlterMe tokens. No client-side code here.
import type { ComponentProps, ReactNode } from 'react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'outline' | 'quiet';
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-on-ink hover:opacity-90',
  outline: 'border border-control-border bg-surface text-ink hover:bg-surface-sand',
  quiet: 'text-periwinkle-ink underline-offset-4 hover:underline',
};

export function Button({ variant = 'primary', className, ...props }: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-pill px-6 text-base font-medium transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON[variant],
        className,
      )}
    />
  );
}

export function TextField({ label, hint, id, className, ...props }: ComponentProps<'input'> & { label: string; hint?: string; id: string }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
        className="min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink placeholder:text-ink-muted"
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'success' | 'danger' | 'info'; children: ReactNode }) {
  const tones = {
    success: 'border-success text-ink',
    danger: 'border-danger text-ink',
    info: 'border-hairline text-ink-body',
  } as const;
  return (
    <p role={tone === 'danger' ? 'alert' : 'status'} className={cx('rounded-md border-l-4 bg-surface-sand px-4 py-3 text-sm', tones[tone])}>
      {children}
    </p>
  );
}
