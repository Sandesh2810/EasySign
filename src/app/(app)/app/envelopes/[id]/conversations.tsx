'use client';
// D-84: each signer's or approver's private conversation with the sender's side. Nothing can be edited or removed; every
// message is in the audit trail. Answers are emailed to the person when the document goes out by email.
import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import { answerQuestionAction, type ActionResult } from '../actions';

export interface Conversation {
  recipientId: string;
  name: string;
  items: { id: string; fromSigner: boolean; body: string; at: string }[];
}

function Thread({ envelopeId, c, canAnswer }: { envelopeId: string; c: Conversation; canAnswer: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(answerQuestionAction, null);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-hairline p-3">
      <h3 className="text-sm font-medium text-ink">{c.name}</h3>
      <ol className="flex flex-col gap-2">
        {c.items.map((m) => (
          <li key={m.id} className={`rounded-md px-3 py-2 ${m.fromSigner ? 'bg-surface-sand' : 'border border-hairline'}`}>
            <p className="text-sm text-ink-muted">
              {m.fromSigner ? c.name : 'You or your team'}, {m.at.slice(0, 16).replace('T', ' ')} UTC
            </p>
            <p className="whitespace-pre-wrap break-words text-base text-ink">{m.body}</p>
          </li>
        ))}
      </ol>
      {canAnswer ? (
        <form action={action} className="flex flex-col gap-2" key={c.items.length}>
          <input type="hidden" name="envelope_id" value={envelopeId} />
          <input type="hidden" name="recipient_id" value={c.recipientId} />
          <label htmlFor={`answer-${c.recipientId}`} className="text-sm font-medium text-ink">
            Answer {c.name}
          </label>
          <textarea id={`answer-${c.recipientId}`} name="body" rows={2} maxLength={1000} required className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
          {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
          <div>
            <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending}>
              {pending ? 'Sending…' : 'Send answer'}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export function Conversations({ envelopeId, conversations, canAnswer }: { envelopeId: string; conversations: Conversation[]; canAnswer: boolean }) {
  if (!conversations.length) return null;
  return (
    <ul className="flex flex-col gap-3" aria-label="Questions and answers">
      {conversations.map((c) => (
        <Thread key={c.recipientId} envelopeId={envelopeId} c={c} canAnswer={canAnswer} />
      ))}
    </ul>
  );
}
