'use client';
// Step 3 on the document page: send the document, then (while it is open) fetch the signing link on request.
import { useActionState, useState, useTransition } from 'react';
import { Button, Notice } from '@/components/ui';
import { PRODUCT_NAME } from '@/config/brand';
import { EXCLUDED_DOCUMENTS } from '@/config/legal';
import { progressLabel, ROLE_LABEL } from '@/lib/recipient-labels';
import type { RecipientStatus, Role } from '@/lib/routing';
import { getSigningLinkAction, sendEnvelopeAction, type ActionResult, type RevealedLink } from '../actions';

const SELECT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';

export function SendPanel({ envelopeId, selfSign, hasSigner }: { envelopeId: string; selfSign: boolean; hasSigner: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(sendEnvelopeAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <p className="text-sm text-ink-body">
        {selfSign
          ? 'You are the signer. Nothing is emailed: you sign straight away in this browser.'
          : 'Once sent, the document, the people and the fields are locked and cannot be edited. Each person is asked when their turn comes.'}
      </p>
      <details className="rounded-md bg-surface-sand px-4 py-2 text-sm text-ink-body">
        <summary className="min-h-11 cursor-pointer py-2.5 font-medium text-ink">Documents you should not send for electronic signature</summary>
        <p className="mt-1">The law treats some documents differently, and an electronic signature may not be valid for them. Do not use {PRODUCT_NAME} for:</p>
        <ul className="mt-2 list-disc pl-5">
          {EXCLUDED_DOCUMENTS.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        <p className="mt-2 pb-2">The rules differ between countries and states. If you are unsure, ask a lawyer before sending.</p>
      </details>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="send-expires" className="text-sm font-medium text-ink">
            The signing links stop working after
          </label>
          <select id="send-expires" name="expires_days" defaultValue="30" className={SELECT}>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
          </select>
          <p className="text-sm text-ink-muted">If someone has not finished by then, the document expires and you are told.</p>
        </div>
        {selfSign ? (
          <input type="hidden" name="remind" value="0" />
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="send-remind" className="text-sm font-medium text-ink">
              Remind people who have not finished
            </label>
            <select id="send-remind" name="remind" defaultValue="3" className={SELECT}>
              <option value="3">Every 3 days, up to 3 times</option>
              <option value="1">Every day, up to 5 times</option>
              <option value="7">Once a week, up to 3 times</option>
              <option value="0">Do not remind</option>
            </select>
            <p className="text-sm text-ink-muted">Reminders are emails. None are sent if you share the links yourself.</p>
          </div>
        )}
      </div>
      {selfSign ? null : (
        // D-83: a signer or approver may give their part to someone else (their link stops working; the handoff is recorded)
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" name="allow_delegation" className="mt-0.5 size-5 shrink-0 accent-ink" />
          <span>
            Let people hand their part to someone else
            <span className="block text-ink-muted">For example to a colleague with authority to sign. Their link stops working, the new person gets their own, and you are told who and why.</span>
          </span>
        </label>
      )}
      {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {selfSign ? (
          <Button type="submit" name="delivery" value="link" disabled={pending || !hasSigner}>
            {pending ? 'Preparing…' : 'Lock and start signing'}
          </Button>
        ) : (
          <>
            <Button type="submit" name="delivery" value="email" disabled={pending || !hasSigner}>
              {pending ? 'Sending…' : 'Send by email'}
            </Button>
            <Button type="submit" name="delivery" value="link" variant="outline" disabled={pending || !hasSigner}>
              Get a link to share instead
            </Button>
          </>
        )}
      </div>
      {!hasSigner ? <p className="text-sm text-ink-muted">Save at least one person who signs first (step 1).</p> : null}
    </form>
  );
}

export function SigningLinkPanel({ envelopeId, selfSign }: { envelopeId: string; selfSign: boolean }) {
  const [links, setLinks] = useState<RevealedLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      setError(null);
      const res = await getSigningLinkAction(envelopeId);
      if (res.ok) setLinks(res.links);
      else setError(res.message);
    });

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(link);
    } catch {
      setError('Copying was blocked by the browser. Select the link and copy it by hand.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-body">
        {selfSign
          ? 'Open your signing page to finish this document.'
          : 'Anyone who has a link can act as that person. Give each link only to the person it is for. A link opens only when that person\'s turn has come. Showing the links is recorded in the audit trail.'}
      </p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {links === null ? (
        <div>
          <Button type="button" variant={selfSign ? 'primary' : 'outline'} onClick={load} disabled={pending}>
            {pending ? 'Preparing…' : selfSign ? 'Show my signing link' : 'Show signing links'}
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {links.map((l) => (
            <li key={l.link} className="flex flex-col gap-2">
              <label htmlFor={`link-${l.order}-${l.name}`} className="text-sm font-medium text-ink">
                Link for {l.name}
                {selfSign ? null : (
                  <span className="font-normal text-ink-muted">
                    {' '}
                    · {ROLE_LABEL[l.role as Role]} · turn {l.order} · {progressLabel(l.role as Role, l.status as RecipientStatus)}
                  </span>
                )}
              </label>
              <input
                id={`link-${l.order}-${l.name}`}
                readOnly
                value={l.link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-h-11 rounded-sm border border-control-border bg-surface px-3 font-mono text-xs text-ink"
              />
              <div className="flex flex-wrap items-center gap-2">
                {selfSign ? (
                  <a
                    href={l.link}
                    className="inline-flex min-h-11 items-center justify-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline hover:opacity-90"
                  >
                    Sign now
                  </a>
                ) : null}
                <Button type="button" variant="outline" onClick={() => copy(l.link)}>
                  {copied === l.link ? 'Copied' : 'Copy link'}
                </Button>
              </div>
            </li>
          ))}
          {links.length === 0 ? <li className="text-sm text-ink-muted">There is no open signing link for this document.</li> : null}
        </ul>
      )}
    </div>
  );
}
