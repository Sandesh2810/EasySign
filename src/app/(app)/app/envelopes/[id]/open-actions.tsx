'use client';
// What the sender can still do after sending, while the document is open: ask someone again, correct a
// person's name or email, reassign their part to someone else (D-83), or cancel the document for everyone.
import { useActionState, useState, useTransition } from 'react';
import { Button, Notice, TextField } from '@/components/ui';
import { correctRecipientAction, reassignRecipientAction, resendRequestAction, unlockRecipientAction, voidEnvelopeAction, type ActionResult } from '../actions';

export function PersonActions({
  envelopeId,
  person,
  canResend,
  canCorrect,
  canReassign = false,
  locked = false,
}: {
  envelopeId: string;
  person: { id: string; name: string; email: string };
  /** their turn, not finished, and requests go by email */
  canResend: boolean;
  /** not finished yet */
  canCorrect: boolean;
  /** signs or approves and has not finished: their part can go to someone else */
  canReassign?: boolean;
  /** too many wrong codes were typed through this person's link */
  locked?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'correct' | 'reassign'>('correct');
  const [resent, setResent] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [state, action, saving] = useActionState<ActionResult | null, FormData>(async (prev, data) => {
    const res = await (data.get('mode') === 'reassign' ? reassignRecipientAction : correctRecipientAction)(prev, data);
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
            {canReassign ? 'Correct or reassign' : 'Correct name or email'}
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
          <input type="hidden" name="mode" value={mode} />
          {canReassign ? (
            <fieldset className="flex flex-wrap gap-4">
              <legend className="sr-only">What do you want to do?</legend>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="radio" name="mode-choice" checked={mode === 'correct'} onChange={() => setMode('correct')} className="size-5 accent-ink" />
                Correct a mistake (same person)
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="radio" name="mode-choice" checked={mode === 'reassign'} onChange={() => setMode('reassign')} className="size-5 accent-ink" />
                Reassign to someone else
              </label>
            </fieldset>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField id={`fix-name-${person.id}`} name="name" label={mode === 'reassign' ? 'New person’s name' : 'Name'} defaultValue={mode === 'reassign' ? '' : person.name} key={`n-${mode}`} maxLength={120} autoComplete="off" required />
            <TextField id={`fix-email-${person.id}`} name="email" type="email" label={mode === 'reassign' ? 'New person’s email' : 'Email'} defaultValue={mode === 'reassign' ? '' : person.email} key={`e-${mode}`} autoComplete="off" required />
          </div>
          {mode === 'reassign' ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`reassign-reason-${person.id}`} className="text-sm font-medium text-ink">
                Reason (optional; kept with the document and shown on its certificate)
              </label>
              <textarea id={`reassign-reason-${person.id}`} name="reason" rows={2} maxLength={500} className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
            </div>
          ) : null}
          <p className="text-sm text-ink-muted">
            {mode === 'reassign'
              ? `${person.name}’s link stops working at once and the new person gets their own. Anything ${person.name} had started is cleared. The handoff is recorded.`
              : 'Changing the email switches off the link the old address had and issues a new one. If the old address had already opened, agreed or started filling in the document, that is cleared and the new person starts fresh. People who have already finished are not affected.'}
          </p>
          {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-10 px-4 text-sm" disabled={saving}>
              {saving ? 'Saving…' : mode === 'reassign' ? 'Reassign' : 'Save correction'}
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
