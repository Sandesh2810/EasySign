'use client';
import { useActionState, useState } from 'react';
import { Button, Notice, TextField } from '@/components/ui';
import { recoverWithCodeAction, verifyMfaAction, type MfaResult } from '@/lib/auth/mfa-actions';

export function MfaCodeForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<MfaResult | null, FormData>(verifyMfaAction, null);
  const [recovery, setRecovery] = useState(false);
  const [rState, rAction, rPending] = useActionState<MfaResult | null, FormData>(recoverWithCodeAction, null);

  if (recovery) {
    return (
      <form action={rAction} className="mt-6 flex flex-col gap-4">
        <p className="text-base text-ink-body">
          Lost your phone? Enter one of the recovery codes you saved when you set this up. It switches two-step sign-in off, so you can set it up again on a new phone. Each code works once.
        </p>
        <TextField id="recovery" name="recovery" label="Recovery code" autoComplete="off" spellCheck={false} placeholder="ABCDE-FGH23" required />
        {rState && !rState.ok ? <Notice tone="danger">{rState.message}</Notice> : null}
        <Button type="submit" disabled={rPending}>{rPending ? 'Checking…' : 'Use recovery code'}</Button>
        <Button type="button" variant="quiet" onClick={() => setRecovery(false)}>Back to the authenticator code</Button>
      </form>
    );
  }
  return (
    <form action={action} className="mt-6 flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <TextField id="code" name="code" label="Six-digit code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
      {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
      <Button type="submit" disabled={pending}>{pending ? 'Checking…' : 'Continue'}</Button>
      <Button type="button" variant="quiet" onClick={() => setRecovery(true)}>I cannot use my authenticator app</Button>
    </form>
  );
}
