// D-92: Settings → Webhooks. Owners and administrators add endpoints and read the delivery log.
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '@/components/ui';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { MAX_ATTEMPTS, REPLAY_WINDOW_SECONDS } from '@/lib/webhooks/events';
import { activeWorkspace } from '@/lib/workspace';
import { RedeliverButton, Webhooks, type EndpointRow } from './webhooks';

export const metadata: Metadata = { title: 'Webhooks' };

interface Delivery {
  id: string;
  event_type: string;
  status: 'pending' | 'sending' | 'delivered' | 'failed';
  attempts: number;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  payload: unknown;
  tries: { attempt: number; at: string; status_code: number | null; error: string | null; duration_ms: number }[];
}

const when = (s: string | null) => (s ? `${s.slice(0, 19).replace('T', ' ')} UTC` : '');
const STATUS: Record<Delivery['status'], string> = { pending: 'Waiting to retry', sending: 'Sending', delivered: 'Delivered', failed: 'Failed' };

function DeliveryLog({ endpoint, deliveries }: { endpoint: EndpointRow; deliveries: Delivery[] }) {
  return (
    <section id="delivery-log" className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="log-heading">
      <h2 id="log-heading" className="mb-1 text-base font-medium text-ink">
        Delivery log
      </h2>
      <p className="mb-4 text-sm text-ink-muted [overflow-wrap:anywhere]">
        The latest 50 deliveries to <span className="font-mono">{endpoint.url}</span>, newest first, kept for 30 days.{' '}
        <Link href={`/app/settings/webhooks?log=${endpoint.id}#delivery-log`} className="text-periwinkle-ink underline underline-offset-4">
          Refresh
        </Link>
      </p>
      {deliveries.length === 0 ? <p className="text-sm text-ink-muted">Nothing sent yet. Use &ldquo;Send a test event&rdquo; to try the endpoint.</p> : null}
      <ul className="divide-y divide-hairline">
        {deliveries.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 py-3" data-testid="webhook-delivery">
            <p className="text-base text-ink">
              <code className="font-mono text-sm">{d.event_type}</code> · <span className={d.status === 'failed' ? 'font-medium text-danger' : d.status === 'delivered' ? 'font-medium text-ink' : 'text-ink'}>{STATUS[d.status]}</span>
              {d.status === 'pending' && d.next_attempt_at ? ` (next try ${when(d.next_attempt_at)})` : ''}
            </p>
            <p className="text-sm text-ink-muted">
              Queued {when(d.created_at)} · {d.attempts} of {MAX_ATTEMPTS} attempts{d.delivered_at ? ` · delivered ${when(d.delivered_at)}` : ''}
              {d.last_error ? ` · ${d.last_error}` : ''}
            </p>
            <p className="font-mono text-sm text-ink-muted [overflow-wrap:anywhere]">webhook-id {d.id}</p>
            {d.tries.length ? (
              <details>
                <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink">Every attempt ({d.tries.length})</summary>
                <ol className="flex flex-col gap-1 pl-4 text-sm text-ink-body">
                  {d.tries.map((t) => (
                    <li key={t.attempt}>
                      {t.attempt}. {when(t.at)}: {t.status_code ? `HTTP ${t.status_code}` : 'no answer'}
                      {t.error ? ` · ${t.error}` : ''} · {t.duration_ms} ms
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink">What was sent</summary>
              <pre tabIndex={0} role="region" aria-label={`What was sent (${d.event_type})`} className="overflow-x-auto rounded-sm bg-surface-sand p-3 font-mono text-xs text-ink">{JSON.stringify(d.payload, null, 2)}</pre>
            </details>
            {d.status === 'failed' && endpoint.enabled ? (
              <div>
                <RedeliverButton id={d.id} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser('/app/settings/webhooks');
  const { current: ws } = await activeWorkspace(user.id);
  if (ws.role !== 'owner' && ws.role !== 'admin') {
    return <Notice tone="info">Only owners and administrators of {ws.name} can manage webhooks.</Notice>;
  }
  const { data: list, error } = await supabaseAdmin().rpc('webhook_endpoint_list', { p_actor: user.id, p_org: ws.orgId });
  if (error) return <Notice tone="danger">The webhooks could not be loaded. Try again in a moment.</Notice>;
  const endpoints = (list ?? []) as EndpointRow[];
  const wanted = (await searchParams).log;
  const logEndpoint = typeof wanted === 'string' ? endpoints.find((e) => e.id === wanted) ?? null : null;
  const deliveries = logEndpoint ? (((await supabaseAdmin().rpc('webhook_delivery_list', { p_actor: user.id, p_endpoint: logEndpoint.id, p_limit: 50 })).data ?? []) as Delivery[]) : [];
  return (
    <>
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="endpoints-heading">
        <p className="text-sm text-ink-muted">{ws.name}</p>
        <h2 id="endpoints-heading" className="mb-1 mt-1 text-base font-medium text-ink">
          Endpoints
        </h2>
        <p className="mb-4 text-sm text-ink-muted">
          Each event is posted as JSON and signed with the endpoint&apos;s secret (HMAC-SHA256 with a timestamp, the open &ldquo;Standard Webhooks&rdquo; format), so the receiver can check it came from us and refuse anything older than {REPLAY_WINDOW_SECONDS / 60} minutes. A failed delivery is retried {MAX_ATTEMPTS - 1} times over about 21 hours. Only https addresses on the public internet are accepted. How to check a signature: <Link href="/developers#webhooks" className="text-periwinkle-ink underline underline-offset-4">API documentation</Link>.
        </p>
        <Webhooks orgId={ws.orgId} endpoints={endpoints} logId={logEndpoint?.id ?? null} />
      </section>
      {logEndpoint ? <DeliveryLog endpoint={logEndpoint} deliveries={deliveries} /> : null}
    </>
  );
}

export default function WebhooksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <p className="text-sm">
        <Link href="/app/settings" className="text-periwinkle-ink underline underline-offset-4">
          Settings
        </Link>
      </p>
      <h1 className="text-2xl font-medium text-ink">Webhooks</h1>
      <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
