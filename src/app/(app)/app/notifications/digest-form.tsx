'use client';
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { setDigestAction, type NoticeResult } from './actions';

export function DigestForm({ on }: { on: boolean }) {
  const [state, action, pending] = useActionState<NoticeResult | null, FormData>(setDigestAction, null);
  return (
    <form action={action} className="flex flex-col items-start gap-3">
      <input type="hidden" name="digest" value={on ? '0' : '1'} />
      <p className="text-sm text-ink">
        Daily summary by email: <strong className="font-medium">{on ? 'on' : 'off'}</strong>
      </p>
      <Button type="submit" variant={on ? 'outline' : 'primary'} className="min-h-11 px-5 text-sm" disabled={pending}>
        {pending ? 'Saving…' : on ? 'Stop the daily summary' : 'Email me a daily summary'}
      </Button>
      {state ? (
        <p role={state.ok ? 'status' : 'alert'} className="text-sm text-ink">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
