'use client';
// D-84: a draft scheduled to be sent: when, and a way to cancel (which unlocks the draft). A failed scheduled send says why.
import { useState, useTransition } from 'react';
import { Button, Notice } from '@/components/ui';
import { cancelScheduledSendAction, type ActionResult } from '../actions';

export function ScheduleBanner({ envelopeId, sendAt, status, error, delivery }: { envelopeId: string; sendAt: string; status: string; error: string | null; delivery: string }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const when = `${new Date(sendAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  if (status === 'failed') {
    return (
      <Notice tone="danger">
        The scheduled send at {when} did not go out{error ? `: ${error.replace(/^ES_[A-Z_]+:\s*/, '')}` : ''}. The document is still a draft: fix it, then send it or schedule it again.
      </Notice>
    );
  }
  if (status !== 'scheduled') return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-5">
      <p className="text-base text-ink">
        <strong>Scheduled</strong> to be sent on <span suppressHydrationWarning>{when}</span> ({new Date(sendAt).toLocaleString()} your time){delivery === 'email' ? ', by email' : '; you share the links yourself after that'}.
      </p>
      <p className="text-sm text-ink-body">Until then the document, the people and the fields cannot be changed. To change something, cancel the scheduled send first.</p>
      {result && !result.ok ? <Notice tone="danger">{result.message}</Notice> : null}
      <div>
        <Button type="button" variant="outline" disabled={pending} onClick={() => start(async () => setResult(await cancelScheduledSendAction(envelopeId).catch(() => ({ ok: false as const, message: 'Could not reach the server.' }))))}>
          {pending ? 'Cancelling…' : 'Cancel the scheduled send'}
        </Button>
      </div>
    </div>
  );
}
