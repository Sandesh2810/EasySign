// Email dispatch. This is the only code that hands a message to a MailProvider, and it does so only
// after the Email Budget Manager (src/lib/email-budget.ts, D-27) says the message may go today.
// Outbox rows never contain a signing link: the link is derived here, in memory, at send time (D-21).
import { env } from '@/lib/env';
import { decide, nextUtcMidnight, type BudgetState, type EmailClass } from '@/lib/email-budget';
import { byteaToBuffer, signingLink } from '@/lib/signing/links';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getMailProvider } from '@/mail';
import { completionTemplate, declinedTemplate, expiredTemplate, signatureRequestTemplate, voidedTemplate, type RenderedEmail, type RequestPurpose } from '@/mail/templates';
import { MailQuotaError, type MailAttachment } from '@/mail/types';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

interface OutboxRow {
  id: string;
  envelope_id: string | null;
  recipient_id: string | null;
  to_user_id: string | null;
  sender_user_id: string | null;
  kind: string;
  priority: EmailClass;
  idempotency_key: string;
}

interface Prepared {
  to: string;
  email: RenderedEmail;
  attachments?: MailAttachment[];
}

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

async function prepare(row: OutboxRow): Promise<Prepared> {
  const db = supabaseAdmin();
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

async function budgetFor(senderId: string | null): Promise<{ state: BudgetState; userSentToday: number; restricted: boolean }> {
  const db = supabaseAdmin();
  const [state, control] = await Promise.all([
    db.rpc('email_budget_state', { p_user: senderId }),
    senderId ? db.from('account_controls').select('trust_level').eq('user_id', senderId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const s = Array.isArray(state.data) ? state.data[0] : null;
  if (state.error || !s) throw new Error('email budget unavailable');
  return {
    state: {
      sentTodayAuth: s.sent_today_auth,
      sentTodayShared: s.sent_today_shared,
      sentMonthBeforeToday: s.sent_month_before_today,
      daysLeftInMonth: s.days_left_in_month,
      restrictedSentToday: s.restricted_sent_today,
      providerClosed: s.provider_closed,
    },
    userSentToday: s.user_sent_today ?? 0,
    restricted: (control.data?.trust_level as string | undefined) === 'restricted',
  };
}

/** Claims a batch and works through it in priority order. Returns how many rows were handled. */
export async function runOutbox(log: (msg: string) => void): Promise<number> {
  const db = supabaseAdmin();
  const claim = await db.rpc('claim_outbox', { p_limit: 10, p_lease_seconds: 120 });
  if (claim.error) throw new Error(`claim_outbox: ${claim.error.message}`);
  const rows = (claim.data ?? []) as OutboxRow[];
  const finish = async (id: string, outcome: 'sent' | 'deferred' | 'failed', extra: { notBefore?: Date; messageId?: string; error?: string } = {}) => {
    const res = await db.rpc('finish_outbox', {
      p_id: id,
      p_outcome: outcome,
      p_not_before: extra.notBefore?.toISOString() ?? null,
      p_provider_message_id: extra.messageId ?? null,
      p_error: extra.error ?? null,
    });
    return (res.data as string | null) ?? res.error?.message ?? 'unknown';
  };

  for (const row of rows) {
    try {
      const budget = await budgetFor(row.sender_user_id);
      const verdict = decide(row.priority, budget.state, undefined, { restrictedSender: budget.restricted, userSentToday: budget.userSentToday });
      if (verdict.action === 'defer') {
        log(`email ${row.kind} ${row.id}: ${await finish(row.id, 'deferred', { notBefore: verdict.notBefore, error: verdict.reason })} (budget)`);
        continue;
      }
      const prepared = await prepare(row);
      const sent = await getMailProvider().send({
        to: prepared.to,
        kind: row.kind,
        subject: prepared.email.subject,
        html: prepared.email.html,
        text: prepared.email.text,
        attachments: prepared.attachments,
        idempotencyKey: row.idempotency_key,
      });
      await db.rpc('email_budget_record', { p_class: row.priority, p_user: row.sender_user_id, p_restricted: budget.restricted });
      log(`email ${row.kind} ${row.id}: ${await finish(row.id, 'sent', { messageId: sent.id })}`);
    } catch (e) {
      if (e instanceof MailQuotaError) {
        await db.rpc('email_budget_close_day');
        log(`email ${row.kind} ${row.id}: ${await finish(row.id, 'deferred', { notBefore: nextUtcMidnight(new Date()), error: 'provider quota reached' })} (provider quota)`);
        continue;
      }
      // the error text may describe a person or a document, so only its message is stored, never a link
      const message = e instanceof Error ? e.message : 'unknown error';
      log(`email ${row.kind} ${row.id}: ${await finish(row.id, 'failed', { error: message })} (${message})`);
    }
  }
  return rows.length;
}
