// Bulk send in the worker (Phase 4 slice 9, AT4.2, D-85). A few rows per tick, each under a lease:
//  1. the draft: made from the template, or the one an earlier attempt already made (so a retry never makes a second);
//     a draft that an earlier attempt already sent is simply counted as sent (no duplicate document, no second email);
//  2. the row's values become the draft's prefilled values;
//  3. for a batch sent by email, only as many go out as today's request-email allowance can carry (spread over days);
//  4. sent with a fresh link; a daily limit makes the row wait until tomorrow; other errors retry, then fail with a reason.
import { bulkSendable } from '@/lib/bulk';
import { allowanceFor, DEFAULT_BUDGET, nextUtcMidnight } from '@/lib/email-budget';
import { loadBudget } from '@/lib/email-budget-state';
import { friendlyDbError } from '@/lib/db-error';
import { mintTokenRecord } from '@/lib/signing/links';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { draftFromTemplate } from '@/lib/template-use';

const PER_TICK = 5;
const MAX_ATTEMPTS = 3;

interface Item {
  id: string;
  batch_id: string;
  row_no: number;
  name: string;
  email: string;
  values: Record<string, string>;
  envelope_id: string | null;
  attempts: number;
  created_by: string;
  template_id: string | null;
  org_id: string;
  title: string;
  delivery: 'email' | 'link';
  expires_days: number;
}

async function finish(id: string, status: 'sent' | 'failed' | 'pending', reason: string | null, notBefore: Date | null = null) {
  const { error } = await supabaseAdmin().rpc('finish_bulk_item', { p_item_id: id, p_status: status, p_reason: reason, p_not_before: notBefore?.toISOString() ?? null });
  if (error) throw new Error(`finish_bulk_item: ${error.message}`);
}

/** How many email documents each sender may send now (today's request allowance less request emails already waiting). */
async function emailQuota(userId: string): Promise<number> {
  const snap = await loadBudget(userId);
  const { left } = allowanceFor('P0_REQUEST', snap.state, DEFAULT_BUDGET, { userSentToday: snap.userSentToday, restrictedSender: snap.restricted });
  const { count } = await supabaseAdmin().from('notification_outbox').select('id', { count: 'exact', head: true }).eq('status', 'queued').eq('priority', 'P0_REQUEST');
  return bulkSendable(left, count ?? 0, PER_TICK);
}

async function processItem(it: Item, quota: Map<string, number>): Promise<'sent' | 'waiting' | 'failed' | 'retry'> {
  const db = supabaseAdmin();
  // 1. the draft, made once
  let envelopeId = it.envelope_id;
  if (envelopeId) {
    const { data: env } = await db.from('envelopes').select('status').eq('id', envelopeId).maybeSingle();
    if (env && env.status !== 'draft') {
      await finish(it.id, 'sent', null); // an earlier attempt sent it and stopped before recording that
      return 'sent';
    }
    if (!env) envelopeId = null; // the draft was deleted meanwhile: make a new one
  }
  if (it.delivery === 'email') {
    if (!quota.has(it.created_by)) quota.set(it.created_by, await emailQuota(it.created_by));
    if ((quota.get(it.created_by) ?? 0) <= 0) {
      await finish(it.id, 'pending', 'Waiting for the next day’s email allowance.', nextUtcMidnight(new Date()));
      return 'waiting';
    }
  }
  if (!envelopeId) {
    if (!it.template_id) {
      await finish(it.id, 'failed', 'The template was deleted.');
      return 'failed';
    }
    const { data: role } = await db.from('template_roles').select('id').eq('template_id', it.template_id).single();
    if (!role) {
      await finish(it.id, 'failed', 'The template has changed and no longer has one person.');
      return 'failed';
    }
    envelopeId = await draftFromTemplate(it.created_by, it.template_id, `${it.title} — ${it.name}`.slice(0, 200), [{ role_id: role.id as string, name: it.name, email: it.email }]);
    const set = await db.rpc('set_bulk_item_envelope', { p_item_id: it.id, p_envelope_id: envelopeId });
    if (set.error) throw new Error(`set_bulk_item_envelope: ${set.error.message}`);
  }
  // 2. the row's values
  if (it.values && Object.keys(it.values).length) {
    const applied = await db.rpc('bulk_apply_values', { p_envelope_id: envelopeId, p_values: it.values });
    if (applied.error) {
      await finish(it.id, 'failed', friendlyDbError(applied.error.message).message);
      return 'failed';
    }
  }
  // 3 and 4. send with a fresh link
  const { data: recipient } = await db.from('recipients').select('id').eq('envelope_id', envelopeId).neq('role', 'cc').limit(1).single();
  if (!recipient) throw new Error('the draft has no recipient');
  const token = mintTokenRecord(recipient.id as string);
  const expires = new Date(Date.now() + it.expires_days * 86400_000).toISOString();
  const sent = await db.rpc('send_envelope', { p_actor: it.created_by, p_envelope_id: envelopeId, p_tokens: [token], p_expires_at: expires, p_delivery: it.delivery });
  if (sent.error) {
    const f = friendlyDbError(sent.error.message);
    if (f.code === 'ES_ENVELOPE_CAP' || f.code === 'ES_RECIPIENT_CAP') {
      await finish(it.id, 'pending', `Waiting for tomorrow: ${f.message}`, nextUtcMidnight(new Date()));
      return 'waiting';
    }
    if (it.attempts >= MAX_ATTEMPTS || f.code !== 'ES_ERROR') {
      await finish(it.id, 'failed', f.message);
      return 'failed';
    }
    await finish(it.id, 'pending', f.message, new Date(Date.now() + 5 * 60_000));
    return 'retry';
  }
  if (it.delivery === 'email') quota.set(it.created_by, (quota.get(it.created_by) ?? 1) - 1);
  await finish(it.id, 'sent', null);
  return 'sent';
}

/** One pass: returns how many rows were dealt with (0 = nothing to do). */
export async function runBulk(log: (msg: string) => void): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('claim_bulk_items', { p_limit: PER_TICK });
  if (error) throw new Error(`claim_bulk_items: ${error.message}`);
  const items = (data ?? []) as Item[];
  if (!items.length) return 0;
  const quota = new Map<string, number>();
  const tally: Record<string, number> = {};
  for (const it of items) {
    let outcome: string;
    try {
      outcome = await processItem(it, quota);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      outcome = it.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
      await finish(it.id, outcome === 'failed' ? 'failed' : 'pending', msg.slice(0, 300), outcome === 'failed' ? null : new Date(Date.now() + 5 * 60_000)).catch(() => {});
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  log(`bulk: ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  return items.length;
}
