'use client';
import { useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { returnToAccountAction } from './actions';

export function ReturnForm({ sessionId }: { sessionId: string }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-6 flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        const res = await returnToAccountAction(sessionId, pin).catch((err: unknown) => {
          if (err && typeof err === 'object' && 'digest' in err && String((err as { digest: unknown }).digest).startsWith('NEXT_REDIRECT')) throw err;
          return { ok: false as const, message: 'We could not reach the server. Try again.' };
        });
        setBusy(false);
        setPin('');
        if (!res.ok) setError(res.message);
      }}
    >
      <label htmlFor="return-pin" className="text-sm font-medium text-ink">
        Your PIN
      </label>
      <input
        id="return-pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]*"
        maxLength={8}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        className="min-h-11 w-48 rounded-sm border border-control-border bg-surface px-3 text-base tracking-widest text-ink"
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div>
        <Button type="submit" disabled={busy || pin.length < 4}>
          {busy ? 'Checking…' : 'Return to my account'}
        </Button>
      </div>
    </form>
  );
}
