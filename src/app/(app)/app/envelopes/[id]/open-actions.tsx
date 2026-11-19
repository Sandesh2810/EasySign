'use client';
// What the sender can still do after sending, while the document is open: ask someone again, correct a
// person's name or email, or cancel the document for everyone.
import { useActionState, useState, useTransition } from 'react';
import { Button, Notice, TextField } from '@/components/ui';
import { correctRecipientAction, resendRequestAction, unlockRecipientAction, voidEnvelopeAction, type ActionResult } from '../actions';

export function PersonActions({
  envelopeId,
  person,
  canResend,
  canCorrect,
  locked = false,
}: {
  envelopeId: string;
  person: { id: string; name: string; email: string };
  /** their turn, not finished, and requests go by email */
  canResend: boolean;
  /** not finished yet */
  canCorrect: boolean;
  /** too many wrong codes were typed through this person's link */
  locked?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [resent, setResent] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [state, action, saving] = useActionState<ActionResult | null, FormData>(async (prev, data) => {
    const res = await correctRecipientAction(prev, data);
    if (res.ok) setEditing(false);
    return res;
  }, null);
  if (!canResend && !canCorrect && !locked) return null;

  return (
    <div className="flex flex-col gap-2 sm:col-span-4">
      <div className="flex flex-wrap items-center gap-2">
        {canResend ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-10 px-4 text-sm"
            disabled={pending}
            aria-label={`Send the request to ${person.name} again`}
            onClick={() => start(async () => setResent(await resendRequestAction(envelopeId, person.id).catch(() => ({ ok: false as const, message: 'Could not reach the server.' }))))}
          >
            {pending ? 'Sending…' : 'Send again'}
          </Button>
        ) : null}
        {locked ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-10 px-4 text-sm"
            disabled={pending}
            aria-label={`Unlock the link of ${person.name}`}
            onClick={() => start(async () => setResent(await unlockRecipientAction(envelopeId, person.id).catch(() => ({ ok: false as const, message: 'Could not reach the server.' }))))}
          >
            Unlock their link
          </Button>
        ) : null}
        {canCorrect && !editing ? (
          <Button type="button" variant="outline" className="min-h-10 px-4 text-sm" aria-label={`Correct the name or email of ${person.name}`} onClick={() => setEditing(true)}>
            Correct name or email
          </Button>
        ) : null}
        {resent ? (
          <span role={resent.ok ? 'status' : 'alert'} className="text-sm text-ink">
            {resent.message}
          </span>
        ) : null}
        {state && !editing ? (
          <span role="status" className="text-sm text-ink">
            {state.message}
          </span>
        ) : null}
      </div>
      {editing ? (
        <form action={action} className="flex flex-col gap-3 rounded-md border border-hairline p-3">
          <input type="hidden" name="envelope_id" value={envelopeId} />
          <input type="hidden" name="recipient_id" value={person.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField id={`fix-name-${person.id}`} name="name" label="Name" defaultValue={person.name} maxLength={120} autoComplete="off" required />
            <TextField id={`fix-email-${person.id}`} name="email" type="email" label="Email" defaultValue={person.email} autoComplete="off" required />
          </div>
          <p className="text-sm text-ink-muted">
            Changing the email switches off the link the old address had and issues a new one. If the old address had already opened, agreed or started filling in the document, that is cleared and the new person starts fresh.
            People who have already finished are not affected.
          </p>
          {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-10 px-4 text-sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save correction'}
            </Button>
            <Button type="button" variant="outline" className="min-h-10 px-4 text-sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function VoidPanel({ envelopeId }: { envelopeId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(voidEnvelopeAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <p className="text-sm text-ink-body">
        Cancelling stops the document for everyone. Every signing link is switched off at once, people who were already asked are told, and signatures already given do not take effect. This cannot be undone; to try again you create a new document.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="void-reason" className="text-sm font-medium text-ink">
          Reason (optional; kept with the document for your records)
        </label>
        <textarea id="void-reason" name="reason" rows={2} maxLength={1000} className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
      </div>
      <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" name="confirm" className="mt-0.5 size-5 shrink-0 accent-ink" />
        <span>I want to cancel this document for everyone.</span>
      </label>
      {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Cancelling…' : 'Cancel this document'}
        </Button>
      </div>
    </form>
  );
}
