// D-92: webhook delivery. Claims due deliveries (the database decides what is due, retries and backoff), signs each
// one with the endpoint's secret (and the previous one during a change), posts it and records the attempt. Only the
// receiver's scheme and host are logged; a query string can carry the receiver's own token.
import { PRODUCT_NAME } from '@/config/brand';
import { env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { postWebhook, type DeliveryResult } from '@/lib/webhooks/deliver';
import { openSecret } from '@/lib/webhooks/secret-box';
import { signatureHeader } from '@/lib/webhooks/signature';
import { loopbackAllowed } from '@/lib/webhooks/url-guard';

interface Claimed {
  id: string;
  endpoint_id: string;
  url: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  secret_enc: string;
  previous_secret_enc: string | null;
}

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return 'an invalid address';
  }
};

async function deliverOne(row: Claimed, allowLoopback: boolean): Promise<DeliveryResult> {
  let secrets: string[];
  try {
    secrets = [openSecret(row.secret_enc, row.endpoint_id, env.storageKey())];
    if (row.previous_secret_enc) secrets.push(openSecret(row.previous_secret_enc, row.endpoint_id, env.storageKey()));
  } catch {
    return { ok: false, statusCode: null, error: 'Not sent: the signing secret could not be read (change the secret on the Webhooks page)', durationMs: 0 };
  }
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  return postWebhook(
    row.url,
    body,
    {
      'content-type': 'application/json',
      'user-agent': `${PRODUCT_NAME}-Webhooks/1.0`,
      'webhook-id': row.id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signatureHeader(secrets, row.id, timestamp, body),
    },
    { allowLoopback },
  );
}

/** One pass: returns the number of deliveries attempted. */
export async function runWebhooks(log: (msg: string) => void): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc('webhook_claim', { p_limit: 10 });
  if (error) throw new Error(`webhook_claim: ${error.message}`);
  const rows = (data ?? []) as Claimed[];
  if (rows.length === 0) return 0;
  const allowLoopback = loopbackAllowed(process.env);
  await Promise.all(
    rows.map(async (row) => {
      const r = await deliverOne(row, allowLoopback);
      const res = await db.rpc('webhook_result', { p_delivery: row.id, p_ok: r.ok, p_status_code: r.statusCode, p_error: r.error, p_duration_ms: r.durationMs });
      if (res.error) throw new Error(`webhook_result: ${res.error.message}`);
      log(`webhook ${row.event_type} to ${origin(row.url)}: attempt ${row.attempts + 1} ${r.ok ? `delivered (HTTP ${r.statusCode})` : `failed (${r.error})`} -> ${String(res.data)}`);
    }),
  );
  return rows.length;
}

/** Keep the delivery log for 30 days. */
export async function pruneWebhooks(log: (msg: string) => void): Promise<void> {
  const { data, error } = await supabaseAdmin().rpc('webhook_prune', { p_days: 30 });
  if (error) throw new Error(`webhook_prune: ${error.message}`);
  if (typeof data === 'number' && data > 0) log(`webhooks: ${data} old deliver${data === 1 ? 'y' : 'ies'} removed from the log`);
}
