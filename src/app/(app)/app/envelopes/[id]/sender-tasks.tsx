'use client';
// Requests from signers that need the sender (Phase 3, AT3.3): a paper copy, or consent withdrawn.
import { useState, useTransition } from 'react';
import { Button, Notice } from '@/components/ui';
import { completeTaskAction } from '../actions';

export interface TaskView {
  id: string;
  kind: 'paper_copy' | 'consent_withdrawn';
  who: string;
  note: string | null;
  createdAt: string;
}

const WHAT = {
  paper_copy: (who: string) => `${who} asked for a paper copy. Arrange one in whatever way suits you, then mark this done.`,
  consent_withdrawn: (who: string) =>
    `${who} withdrew their consent to sign electronically. What they had filled in was cleared and they cannot sign until they agree again. You can send them a paper copy, correct the recipient or cancel the document.`,
};

export function SenderTasks({ envelopeId, tasks }: { envelopeId: string; tasks: TaskView[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <ul className="flex flex-col gap-4">
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-col gap-2 border-b border-hairline pb-4 last:border-0 last:pb-0">
          <p className="text-base text-ink">{WHAT[t.kind](t.who)}</p>
          {t.note ? <p className="text-sm text-ink-body">{t.kind === 'paper_copy' ? 'Their note' : 'Their reason'}: &ldquo;{t.note}&rdquo;</p> : null}
          <p className="text-sm text-ink-muted">{new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const res = await completeTaskAction(envelopeId, t.id).catch(() => ({ ok: false as const, message: 'We could not reach the server. Try again.' }));
                  if (!res.ok) setError(res.message);
                })
              }
            >
              Mark as done
            </Button>
          </div>
        </li>
      ))}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </ul>
  );
}
