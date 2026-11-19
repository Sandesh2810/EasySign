// The email dispatch loop, with everything it needs from outside passed in. No database, storage or
// provider is imported here, so the loop and the Email Budget Manager can be tested together under load
// (AT2.6) with an in-memory stand-in. src/worker/outbox.ts wires it to the real database and provider.
import { decide, nextUtcMidnight, type EmailClass } from '@/lib/email-budget';
import type { BudgetSnapshot } from '@/lib/email-budget-state';
import type { RenderedEmail } from '@/mail/templates';
import { MailQuotaError, type MailAttachment, type MailMessage, type MailResult } from '@/mail/types';

export interface OutboxRow {
  id: string;
  envelope_id: string | null;
  recipient_id: string | null;
  to_user_id: string | null;
  sender_user_id: string | null;
  kind: string;
  priority: EmailClass;
  idempotency_key: string;
  payload?: Record<string, unknown> | null;
}

export interface Prepared {
  to: string;
  email: RenderedEmail;
  /** where a reply goes: only ever an address that is confirmed (a signed-in account's email) */
  replyTo?: string;
  attachments?: MailAttachment[];
}

/** Everything the dispatch loop needs from outside, so the loop itself can be tested without a database. */
export interface OutboxDeps {
  claim(): Promise<OutboxRow[]>;
  /** Records the outcome. "sent" also counts the email against the budget, in the same database step. */
  finish(id: string, outcome: 'sent' | 'deferred' | 'failed', extra?: { notBefore?: Date; messageId?: string; error?: string }): Promise<string>;
  budget(senderId: string | null): Promise<BudgetSnapshot>;
  prepare(row: OutboxRow): Promise<Prepared>;
  send(message: MailMessage): Promise<MailResult>;
  /** The provider said today's quota is gone: nothing more goes out until the reset. */
  closeDay(): Promise<void>;
  now(): Date;
}

/** Works through one claimed batch in priority order. Returns how many rows were handled. */
export async function drainOutbox(deps: OutboxDeps, log: (msg: string) => void): Promise<number> {
  const rows = await deps.claim();
  for (const row of rows) {
    try {
      const budget = await deps.budget(row.sender_user_id);
      const verdict = decide(row.priority, budget.state, undefined, { restrictedSender: budget.restricted, userSentToday: budget.userSentToday, now: deps.now() });
      if (verdict.action === 'defer') {
        log(`email ${row.kind} ${row.id}: ${await deps.finish(row.id, 'deferred', { notBefore: verdict.notBefore, error: verdict.reason })} (budget)`);
        continue;
      }
      const prepared = await deps.prepare(row);
      const sent = await deps.send({
        to: prepared.to,
        kind: row.kind,
        subject: prepared.email.subject,
        html: prepared.email.html,
        text: prepared.email.text,
        attachments: prepared.attachments,
        replyTo: prepared.replyTo,
        idempotencyKey: row.idempotency_key,
      });
      log(`email ${row.kind} ${row.id}: ${await deps.finish(row.id, 'sent', { messageId: sent.id })}`);
    } catch (e) {
      if (e instanceof MailQuotaError) {
        await deps.closeDay();
        log(`email ${row.kind} ${row.id}: ${await deps.finish(row.id, 'deferred', { notBefore: nextUtcMidnight(deps.now()), error: 'provider quota reached' })} (provider quota)`);
        continue;
      }
      // the error text may describe a person or a document, so only its message is stored, never a link
      const message = e instanceof Error ? e.message : 'unknown error';
      log(`email ${row.kind} ${row.id}: ${await deps.finish(row.id, 'failed', { error: message })} (${message})`);
    }
  }
  return rows.length;
}
