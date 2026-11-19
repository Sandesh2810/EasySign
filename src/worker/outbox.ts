// Email dispatch. This is the only code that hands a message to a MailProvider, and it does so only
// after the Email Budget Manager (src/lib/email-budget.ts, D-27) says the message may go today.
// Outbox rows never contain a signing link: the link is derived here, in memory, at send time (D-21).
import { env } from '@/lib/env';
import { loadBudget } from '@/lib/email-budget-state';
import { describeNotification } from '@/lib/notifications';
import { generateOtp, hashOtp } from '@/lib/signer-token';
import { byteaToBuffer, signingLink } from '@/lib/signing/links';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getMailProvider } from '@/mail';
import { completionTemplate, declinedTemplate, digestTemplate, expiredTemplate, otpTemplate, signatureRequestTemplate, voidedTemplate, type RequestPurpose } from '@/mail/templates';
import { drainOutbox, type OutboxDeps, type OutboxRow, type Prepared } from './dispatch';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

/** Outbox kinds that carry a personal link, and what the recipient is asked to do. */
const REQUEST_PURPOSE: Record<string, RequestPurpose> = { signature_request: 'sign', approval_request: 'approve', view_notice: 'view' };

const safeName = (title: string) => title.replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 80) || 'document';

async function userEmail(userId: string): Promise<{ email: string; name: string }> {
  const db = supabaseAdmin();
  const [{ data: profile }, user] = await Promise.all([db.from('profiles').select('display_name').eq('id', userId).maybeSingle(), db.auth.admin.getUserById(userId)]);
  const email = user.data.user?.email;
  if (!email) throw new Error('recipient account has no email');
  return { email, name: (profile?.display_name as string | undefined) || email };
}

const DIGEST_MAX_LINES = 40;

async function prepareDigest(row: OutboxRow): Promise<Prepared> {
  const db = supabaseAdmin();
  if (!row.to_user_id) throw new Error('digest without a person');
  const from = typeof row.payload?.from === 'string' ? row.payload.from : null;
  const until = typeof row.payload?.to === 'string' ? row.payload.to : null;
  if (!from || !until) throw new Error('digest without a period');
  const [to, { data: notices, count }] = await Promise.all([
    userEmail(row.to_user_id),
    db
      .from('notifications')
      .select('kind, payload, created_at', { count: 'exact' })
      .eq('user_id', row.to_user_id)
      .gt('created_at', from)
      .lte('created_at', until)
      .order('created_at', { ascending: true })
      .limit(DIGEST_MAX_LINES),
  ]);
  const lines = (notices ?? []).map((n) => describeNotification(n.kind as string, n.payload).text);
  if (lines.length === 0) throw new Error('nothing to report');
  return {
    to: to.email,
    email: digestTemplate({ name: to.name, lines, more: Math.max(0, (count ?? lines.length) - lines.length), openUrl: `${env.appUrl()}/app/notifications` }),
  };
}

/**
 * The six-digit code a signer asked for (D-59). The code is made here, at the moment of sending, and
 * exists only in this function and in the email: the database is given a keyed hash and nothing else.
 */
async function prepareOtp(row: OutboxRow): Promise<Prepared> {
  const db = supabaseAdmin();
  if (!row.recipient_id || !row.envelope_id) throw new Error('code request without a person');
  const [{ data: recipient }, { data: envelope }] = await Promise.all([
    db.from('recipients').select('name, email').eq('id', row.recipient_id).maybeSingle(),
    db.from('envelopes').select('title').eq('id', row.envelope_id).maybeSingle(),
  ]);
  if (!recipient || !envelope) throw new Error('recipient not found');
  const code = generateOtp();
  const hash = hashOtp(code, row.recipient_id, env.signerTokenKey());
  // The database refuses a request that is stale, replaced by a newer one, locked, or made through a dead link.
  const stored = await db.rpc('signer_store_otp', { p_outbox_id: row.id, p_otp_hash: `\\x${hash.toString('hex')}` });
  if (stored.error) throw new Error(`code could not be stored: ${stored.error.message}`);
  if (stored.data !== true) throw new Error('code request is no longer current');
  return { to: recipient.email as string, email: otpTemplate({ name: recipient.name as string, title: envelope.title as string, code, minutes: 10 }) };
}

async function prepare(row: OutboxRow): Promise<Prepared> {
  const db = supabaseAdmin();
  if (row.kind === 'digest') return prepareDigest(row);
  if (row.kind === 'otp') return prepareOtp(row);
  if (!row.envelope_id) throw new Error(`unsupported email kind ${row.kind}`);
  const { data: envelope } = await db
    .from('envelopes')
    .select('id, title, status, public_code, sender_id, final_sha256, sealed_storage_backend, sealed_storage_path, certificate_storage_path')
    .eq('id', row.envelope_id)
    .maybeSingle();
  if (!envelope) throw new Error('envelope not found');

  if (row.kind === 'voided_notice') {
    if (envelope.status !== 'voided') throw new Error('envelope is not voided');
    const [{ data: recipient }, sender] = await Promise.all([
      db.from('recipients').select('name, email').eq('id', row.recipient_id!).maybeSingle(),
      userEmail(envelope.sender_id as string),
    ]);
    if (!recipient) throw new Error('recipient not found');
    return { to: recipient.email as string, email: voidedTemplate({ name: recipient.name as string, senderName: sender.name, title: envelope.title as string }) };
  }

  if (row.kind === 'expired_sender') {
    if (envelope.status !== 'expired') throw new Error('envelope is not expired');
    const to = await userEmail((row.to_user_id ?? envelope.sender_id) as string);
    return { to: to.email, email: expiredTemplate({ name: to.name, title: envelope.title as string, openUrl: `${env.appUrl()}/app/envelopes/${envelope.id}` }) };
  }

  if (row.kind === 'declined_sender') {
    if (envelope.status !== 'declined') throw new Error('envelope is not declined');
    const [to, { data: decliner }] = await Promise.all([
      userEmail((row.to_user_id ?? envelope.sender_id) as string),
      row.recipient_id ? db.from('recipients').select('name, decline_reason').eq('id', row.recipient_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    return {
      to: to.email,
      email: declinedTemplate({
        name: to.name,
        title: envelope.title as string,
        declinedBy: (decliner?.name as string | undefined) ?? 'A recipient',
        reason: (decliner?.decline_reason as string | null | undefined) ?? null,
        openUrl: `${env.appUrl()}/app/envelopes/${envelope.id}`,
      }),
    };
  }

  if (Object.hasOwn(REQUEST_PURPOSE, row.kind) || row.kind === 'reminder') {
    if (!row.recipient_id) throw new Error('request without a recipient');
    if (!['sent', 'in_progress'].includes(envelope.status as string)) throw new Error('envelope is no longer open');
    const [{ data: recipient }, { data: token }, sender] = await Promise.all([
      db.from('recipients').select('name, email, role').eq('id', row.recipient_id).maybeSingle(),
      db.from('recipient_tokens').select('id, nonce, expires_at').eq('recipient_id', row.recipient_id).is('revoked_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      userEmail(envelope.sender_id as string),
    ]);
    if (!recipient || !token) throw new Error('recipient or link not found');
    return {
      to: recipient.email as string,
      email: signatureRequestTemplate({
        signerName: recipient.name as string,
        senderName: sender.name,
        title: envelope.title as string,
        signUrl: signingLink(token.id as string, byteaToBuffer(token.nonce as string)),
        expiresOn: new Date(token.expires_at as string).toISOString().slice(0, 10),
        // a reminder repeats the original request, so what it asks for follows the person's role
        purpose: REQUEST_PURPOSE[row.kind] ?? (recipient.role === 'approver' ? 'approve' : recipient.role === 'viewer' ? 'view' : 'sign'),
        reminder: row.kind === 'reminder',
      }),
    };
  }

  if (row.kind === 'completion_copy' || row.kind === 'completion_sender') {
    if (envelope.status !== 'completed' || !envelope.sealed_storage_path || !envelope.certificate_storage_path) throw new Error('envelope is not completed');
    let to: { email: string; name: string };
    if (row.kind === 'completion_sender') to = await userEmail((row.to_user_id ?? envelope.sender_id) as string);
    else {
      const { data: recipient } = await db.from('recipients').select('name, email').eq('id', row.recipient_id!).maybeSingle();
      if (!recipient) throw new Error('recipient not found');
      to = { email: recipient.email as string, name: recipient.name as string };
    }
    const storage = getStorageFor(envelope.sealed_storage_backend as Backend);
    const [sealed, certificate] = await Promise.all([storage.get('sealed', envelope.sealed_storage_path as string), storage.get('sealed', envelope.certificate_storage_path as string)]);
    const base = safeName(envelope.title as string);
    return {
      to: to.email,
      email: completionTemplate({
        name: to.name,
        title: envelope.title as string,
        code: envelope.public_code as string,
        finalSha256: envelope.final_sha256 as string,
        openUrl: row.kind === 'completion_sender' ? `${env.appUrl()}/app/envelopes/${envelope.id}` : undefined,
      }),
      attachments: [
        { filename: `${base} - signed.pdf`, contentType: 'application/pdf', content: sealed },
        { filename: `${base} - certificate.pdf`, contentType: 'application/pdf', content: certificate },
      ],
    };
  }
  throw new Error(`unsupported email kind ${row.kind}`);
}

function liveDeps(): OutboxDeps {
  const db = supabaseAdmin();
  return {
    async claim() {
      const claim = await db.rpc('claim_outbox', { p_limit: 10, p_lease_seconds: 120 });
      if (claim.error) throw new Error(`claim_outbox: ${claim.error.message}`);
      return (claim.data ?? []) as OutboxRow[];
    },
    async finish(id, outcome, extra = {}) {
      const res = await db.rpc('finish_outbox', {
        p_id: id,
        p_outcome: outcome,
        p_not_before: extra.notBefore?.toISOString() ?? null,
        p_provider_message_id: extra.messageId ?? null,
        p_error: extra.error ?? null,
      });
      return (res.data as string | null) ?? res.error?.message ?? 'unknown';
    },
    budget: loadBudget,
    prepare,
    send: (message) => getMailProvider().send(message),
    async closeDay() {
      await db.rpc('email_budget_close_day');
    },
    now: () => new Date(),
  };
}

/** Claims a batch from the database and sends what the budget allows. */
export async function runOutbox(log: (msg: string) => void): Promise<number> {
  return drainOutbox(liveDeps(), log);
}
