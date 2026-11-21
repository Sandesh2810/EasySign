'use client';
// D-92: webhook endpoints for a workspace. A new signing secret is shown once.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { EVENT_LABELS, WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/webhooks/events';
import { createWebhookAction, deleteWebhookAction, redeliverWebhookAction, rotateWebhookSecretAction, testWebhookAction, updateWebhookAction } from './actions';

export interface EndpointRow {
  id: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  enabled: boolean;
  disabled_reason: string | null;
  live: boolean;
  created_at: string;
  last_success_at: string | null;
  previous_until: string | null;
  created_by_name: string;
  week: { delivered: number; failed: number; waiting: number };
}

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const when = (s: string | null) => (s ? `${s.slice(0, 16).replace('T', ' ')} UTC` : 'never');
const OFFLINE = 'Could not reach the server. Nothing was changed.';

function EventChoices({ name, value, onChange }: { name: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium text-ink">Events to send</legend>
      {WEBHOOK_EVENTS.map((e) => (
        <label key={e} className="flex min-h-11 items-center gap-3 text-base text-ink">
          <input type="checkbox" name={name} value={e} checked={value.includes(e)} onChange={(x) => onChange(x.target.checked ? [...value, e] : value.filter((v) => v !== e))} className="size-5 shrink-0 accent-ink" />
          <span>
            {EVENT_LABELS[e]} <code className="font-mono text-sm text-ink-muted">{e}</code>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function SecretOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-control-border p-4" role="status">
      <p className="text-base font-medium text-ink">The signing secret. Copy it into the receiving system now: it will not be shown again.</p>
      <code className="break-all rounded-sm bg-surface-sand px-2 py-1 font-mono text-sm text-ink" data-testid="new-webhook-secret">
        {secret}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true)).catch(() => undefined)}>
          {copied ? 'Copied' : 'Copy the secret'}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          I have stored it
        </Button>
      </div>
    </div>
  );
}

function Endpoint({ e, logOpen, busy, run }: { e: EndpointRow; logOpen: boolean; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message?: string; secret?: string }>) => void }) {
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState<string[]>(e.events);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = !e.enabled ? (e.disabled_reason ?? 'Switched off') : !e.live ? 'Not sending: the person who added it is no longer an owner or administrator' : 'On';
  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="min-w-0">
        <p className="font-mono text-sm text-ink [overflow-wrap:anywhere]">{e.url}</p>
        {e.description ? <p className="text-base text-ink">{e.description}</p> : null}
        <p className="text-sm text-ink-muted">
          <span className={e.enabled && e.live ? 'text-ink' : 'font-medium text-danger'}>{state}</span> · {e.events.join(', ')}
        </p>
        <p className="text-sm text-ink-muted">
          Last 7 days: {e.week.delivered} delivered, {e.week.failed} failed, {e.week.waiting} waiting · last success {when(e.last_success_at)} · added by {e.created_by_name}
          {e.previous_until ? ` · the previous secret also signs until ${when(e.previous_until)}` : ''}
        </p>
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-3 rounded-md border border-hairline p-3"
          onSubmit={(x) => {
            x.preventDefault();
            run(async () => {
              const r = await updateWebhookAction({ id: e.id, events });
              if (r.ok) setEditing(false);
              return r;
            });
          }}
        >
          <EventChoices name={`events-${e.id}`} value={events} onChange={setEvents} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              Save the events
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Link href={logOpen ? '/app/settings/webhooks' : `/app/settings/webhooks?log=${e.id}#delivery-log`} className="inline-flex min-h-11 items-center rounded-pill border border-control-border bg-surface px-6 text-base font-medium text-ink hover:bg-surface-sand">
          {logOpen ? 'Hide the delivery log' : 'Delivery log'}
        </Link>
        <Button type="button" variant="outline" disabled={busy || !e.enabled} onClick={() => run(() => testWebhookAction(e.id))}>
          Send a test event
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => run(() => updateWebhookAction({ id: e.id, enabled: !e.enabled }))}>
          {e.enabled ? 'Switch off' : 'Switch on'}
        </Button>
        {editing ? null : (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            Change events
          </Button>
        )}
        <Button type="button" variant="outline" disabled={busy} onClick={() => run(() => rotateWebhookSecretAction(e.id))}>
          Change the secret
        </Button>
        {confirmDelete ? (
          <>
            <Button type="button" disabled={busy} onClick={() => run(() => deleteWebhookAction(e.id))}>
              Yes, delete it
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

export function Webhooks({ orgId, endpoints, logId }: { orgId: string; endpoints: EndpointRow[]; logId: string | null }) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(['document.completed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message?: string; secret?: string }>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: OFFLINE }) as { ok: boolean; message?: string; secret?: string });
      if (r.ok && r.secret) {
        setSecret(r.secret);
        setMessage(null);
      } else setMessage({ ok: r.ok, text: r.message ?? (r.ok ? 'Done.' : OFFLINE) });
      if (r.ok) router.refresh();
    });

  return (
    <div className="flex flex-col gap-4">
      {secret ? <SecretOnce secret={secret} onDone={() => setSecret(null)} /> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(x) => {
          x.preventDefault();
          run(async () => {
            const r = await createWebhookAction({ orgId, url, description, events });
            if (r.ok) {
              setUrl('');
              setDescription('');
            }
            return r;
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="webhook-url" className="text-sm font-medium text-ink">
            Address that receives the events (https://…)
          </label>
          <input id="webhook-url" type="url" inputMode="url" autoComplete="off" value={url} maxLength={2000} onChange={(x) => setUrl(x.target.value)} className={INPUT} placeholder="https://example.com/younmesign-events" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="webhook-description" className="text-sm font-medium text-ink">
            Description (optional)
          </label>
          <input id="webhook-description" value={description} maxLength={200} onChange={(x) => setDescription(x.target.value)} className={INPUT} />
        </div>
        <EventChoices name="webhook-event" value={events} onChange={setEvents} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Working…' : 'Add the endpoint'}
          </Button>
        </div>
      </form>
      {message ? <Notice tone={message.ok ? 'success' : 'danger'}>{message.text}</Notice> : null}
      {endpoints.length ? (
        <ul className="divide-y divide-hairline" aria-label="Webhook endpoints">
          {endpoints.map((e) => (
            <Endpoint key={e.id} e={e} logOpen={logId === e.id} busy={pending} run={run} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">No endpoints yet.</p>
      )}
    </div>
  );
}

export function RedeliverButton({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await redeliverWebhookAction(id).catch(() => ({ ok: false, message: OFFLINE }));
            setNote(r.message);
            if (r.ok) router.refresh();
          })
        }
      >
        Send again
      </Button>
      {note ? (
        <span role="status" className="text-sm text-ink-muted">
          {note}
        </span>
      ) : null}
    </span>
  );
}
