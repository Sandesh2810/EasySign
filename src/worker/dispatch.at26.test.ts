// AT2.6: the Email Budget Manager under load. 30 documents are sent and completed in one day.
// The real dispatch loop (drainOutbox) and the real decision code (email-budget.ts) run against an
// in-memory stand-in for the database and for the email provider. The stand-in follows the same rules
// as the database functions claim_outbox / finish_outbox / email_budget_state (migrations 7, 8 and 14),
// which are themselves proven by the SQL tests T71, T72, T101, T102, T105 and T106.
import { describe, it, expect } from 'vitest';
import { DEFAULT_BUDGET, meter, type BudgetState, type EmailClass } from '@/lib/email-budget';
import { MailQuotaError, type MailMessage } from '@/mail/types';
import { drainOutbox, type OutboxDeps, type OutboxRow } from './dispatch';

const RANK: Record<EmailClass, number> = { P0_AUTH: 0, P0_REQUEST: 1, P1: 2, P2: 3, P3: 4 };
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

interface Row extends OutboxRow {
  status: 'queued' | 'sending' | 'sent' | 'deferred' | 'dead';
  attempts: number;
  notBefore: Date;
  lockedUntil: Date | null;
  seq: number;
}

/** In-memory database + provider + clock. */
function world(start: string, opts: { providerDailyQuota?: number } = {}) {
  let now = new Date(start);
  let seq = 0;
  const rows: Row[] = [];
  const counters = new Map<string, { auth: number; shared: number; restricted: number; closed: boolean; byUser: Map<string, number> }>();
  const restrictedUsers = new Set<string>();
  /** What the provider really accepted: idempotency key -> day. Same key twice = one email. */
  const delivered = new Map<string, string>();
  let dieOnNextSent = false;
  /** A dead worker does nothing more: every further call fails until it is restarted. */
  let dead = false;

  const dayRow = (day: string) => {
    if (!counters.has(day)) counters.set(day, { auth: 0, shared: 0, restricted: 0, closed: false, byUser: new Map() });
    return counters.get(day)!;
  };
  const budgetState = (): BudgetState => {
    const today = dayOf(now);
    const c = dayRow(today);
    const month = today.slice(0, 7);
    let before = 0;
    for (const [d, v] of counters) if (d.startsWith(month) && d < today) before += v.auth + v.shared;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const daysLeft = Math.round((end.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
    return { sentTodayAuth: c.auth, sentTodayShared: c.shared, sentMonthBeforeToday: before, daysLeftInMonth: daysLeft, restrictedSentToday: c.restricted, providerClosed: c.closed };
  };

  const deps: OutboxDeps = {
    async claim() {
      const due = rows
        .filter((r) => r.notBefore <= now && (r.status === 'queued' || r.status === 'deferred' || (r.status === 'sending' && r.lockedUntil! <= now)))
        .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq)
        .slice(0, 10);
      for (const r of due) {
        r.status = 'sending';
        r.attempts += 1;
        r.lockedUntil = new Date(now.getTime() + 120_000);
      }
      return due;
    },
    async finish(id, outcome, extra = {}) {
      if (outcome === 'sent' && dieOnNextSent) {
        dieOnNextSent = false;
        dead = true;
      }
      if (dead) throw new Error('the worker process is gone');
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== 'sending') return 'ignored';
      r.lockedUntil = null;
      if (outcome === 'sent') {
        r.status = 'sent';
        // one step: the status and the counters change together (migration 14)
        const c = dayRow(dayOf(now));
        if (r.priority === 'P0_AUTH') c.auth += 1;
        else {
          c.shared += 1;
          if (r.sender_user_id && restrictedUsers.has(r.sender_user_id)) c.restricted += 1;
          if (r.sender_user_id) c.byUser.set(r.sender_user_id, (c.byUser.get(r.sender_user_id) ?? 0) + 1);
        }
        return 'sent';
      }
      if (outcome === 'deferred') {
        r.status = 'deferred';
        r.attempts = Math.max(0, r.attempts - 1);
        r.notBefore = extra.notBefore ?? new Date(now.getTime() + 3_600_000);
        return 'deferred';
      }
      r.status = r.attempts >= 5 ? 'dead' : 'queued';
      return r.status === 'dead' ? 'failed' : 'retry';
    },
    async budget(senderId) {
      const c = dayRow(dayOf(now));
      return { state: budgetState(), userSentToday: senderId ? (c.byUser.get(senderId) ?? 0) : 0, restricted: senderId ? restrictedUsers.has(senderId) : false };
    },
    async prepare(row) {
      return { to: `${row.id}@example.test`, email: { subject: row.kind, html: '<p>x</p>', text: 'x' } };
    },
    async send(message: MailMessage) {
      const today = dayOf(now);
      if (!delivered.has(message.idempotencyKey)) {
        const sentToday = [...delivered.values()].filter((d) => d === today).length;
        if (opts.providerDailyQuota !== undefined && sentToday >= opts.providerDailyQuota) throw new MailQuotaError('daily');
        delivered.set(message.idempotencyKey, today);
      }
      return { id: `msg-${message.idempotencyKey}` };
    },
    async closeDay() {
      dayRow(dayOf(now)).closed = true;
    },
    now: () => now,
  };

  return {
    deps,
    rows,
    restrictedUsers,
    queue(kind: string, priority: EmailClass, sender: string | null, key: string) {
      rows.push({ id: key, envelope_id: null, recipient_id: null, to_user_id: null, sender_user_id: sender, kind, priority, idempotency_key: key, status: 'queued', attempts: 0, notBefore: now, lockedUntil: null, seq: seq++ });
    },
    async drainAll() {
      for (let i = 0; i < 200; i++) if ((await drainOutbox(deps, () => {})) === 0) return;
      throw new Error('the queue never emptied');
    },
    setNow(iso: string) {
      now = new Date(iso);
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    crashAfterNextSend() {
      dieOnNextSent = true;
    },
    restartWorker() {
      dead = false;
    },
    deliveredOn: (day: string) => [...delivered.values()].filter((d) => d === day).length,
    deliveredTotal: () => delivered.size,
    counted: (day: string) => {
      const c = dayRow(day);
      return c.auth + c.shared;
    },
    meter: () => meter(budgetState(), DEFAULT_BUDGET, now),
    by: (pred: (r: Row) => boolean) => rows.filter(pred),
  };
}

const DAY1 = '2026-11-10';
const DAY2 = '2026-11-11';
const senders = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];

/** 30 single-signer documents from six trusted senders, plus the day's other email. */
async function busyDay(w: ReturnType<typeof world>) {
  // morning: eight people sign up (their confirmation emails use the reserved share)
  for (let i = 0; i < 8; i++) w.queue('auth_verify', 'P0_AUTH', null, `auth:${i}`);
  // 30 documents go out
  for (let e = 0; e < 30; e++) w.queue('signature_request', 'P0_REQUEST', senders[e % 6]!, `request:${e}`);
  await w.drainAll();
  // early notices and reminders from older documents, while the day is still young
  for (let i = 0; i < 4; i++) w.queue('reminder', 'P2', senders[i]!, `reminder-early:${i}`);
  for (let i = 0; i < 3; i++) w.queue('digest', 'P3', senders[i]!, `digest-early:${i}`);
  await w.drainAll();
  // through the day all 30 are signed: each completion sends a copy to the signer and one to the sender
  w.setNow(`${DAY1}T15:00:00Z`);
  for (let e = 0; e < 30; e++) {
    w.queue('completion_copy', 'P1', senders[e % 6]!, `copy:${e}`);
    w.queue('completion_sender', 'P1', senders[e % 6]!, `copy-sender:${e}`);
    if (e % 5 === 4) await w.drainAll();
  }
  await w.drainAll();
  // late: more reminders, a cancellation notice, summaries, and two more sign-ups and one urgent request
  w.setNow(`${DAY1}T21:00:00Z`);
  for (let i = 0; i < 5; i++) w.queue('reminder', 'P2', senders[i]!, `reminder-late:${i}`);
  w.queue('voided_notice', 'P2', 'u1', 'voided:1');
  for (let i = 0; i < 4; i++) w.queue('digest', 'P3', senders[i]!, `digest-late:${i}`);
  w.queue('auth_verify', 'P0_AUTH', null, 'auth:late-1');
  w.queue('auth_verify', 'P0_AUTH', null, 'auth:late-2');
  w.queue('signature_request', 'P0_REQUEST', 'u6', 'request:late');
  await w.drainAll();
}

describe('AT2.6 email budget under load: 30 documents in one day', () => {
  it('requests and sign-up emails all go out; copies go out up to their cut-off; lower classes wait; nothing is lost; the meter matches the provider', async () => {
    const w = world(`${DAY1}T08:00:00Z`);
    await busyDay(w);
    const total = w.rows.length;
    expect(total).toBe(10 + 31 + 9 + 7 + 60 + 1);

    const sent = (kind: string) => w.by((r) => r.kind === kind && r.status === 'sent').length;
    const held = (kind: string) => w.by((r) => r.kind === kind && r.status === 'deferred').length;

    // P0: every request to sign and every sign-up email was delivered on the day
    expect(sent('signature_request')).toBe(31);
    expect(sent('auth_verify')).toBe(10);
    // P2/P3 queued while the day was young went out; the late ones wait
    expect(sent('reminder')).toBe(4);
    expect(held('reminder')).toBe(5);
    expect(sent('digest')).toBe(3);
    expect(held('digest')).toBe(4);
    expect(held('voided_notice')).toBe(1);
    // P1: copies stop at 90% of the shared pool (76 of 85), leaving room for requests
    const copiesSent = sent('completion_copy') + sent('completion_sender');
    const copiesHeld = held('completion_copy') + held('completion_sender');
    expect(copiesSent + copiesHeld).toBe(60);
    expect(copiesSent).toBe(76 - 30 - 4 - 3);
    expect(copiesHeld).toBe(60 - copiesSent);

    // nothing lost, nothing failed, nothing stuck
    expect(w.by((r) => r.status === 'sent').length + w.by((r) => r.status === 'deferred').length).toBe(total);
    expect(w.by((r) => r.status === 'dead' || r.status === 'queued' || r.status === 'sending').length).toBe(0);
    // every held email is scheduled for the next daily reset, not dropped and not "sometime"
    for (const r of w.by((x) => x.status === 'deferred')) expect(r.notBefore.toISOString()).toBe(`${DAY2}T00:00:00.000Z`);

    // the meter equals what the provider accepted, and stays inside the day's limit
    const m = w.meter();
    expect(w.counted(DAY1)).toBe(w.deliveredOn(DAY1));
    expect(m.usedToday).toBe(w.deliveredOn(DAY1));
    expect(w.deliveredOn(DAY1)).toBeLessThanOrEqual(DEFAULT_BUDGET.dailyCap);
    expect(m.usedToday).toBe(10 + 31 + 4 + 3 + copiesSent);
    expect(m.authLeft).toBe(DEFAULT_BUDGET.authReserveDaily - 10);
  });

  it('the next day everything that waited is delivered, each email exactly once', async () => {
    const w = world(`${DAY1}T08:00:00Z`);
    await busyDay(w);
    const waiting = w.by((r) => r.status === 'deferred').length;
    expect(waiting).toBeGreaterThan(0);
    w.setNow(`${DAY1}T23:59:00Z`);
    await w.drainAll();
    expect(w.by((r) => r.status === 'deferred').length).toBe(waiting); // not a minute early

    w.setNow(`${DAY2}T00:01:00Z`);
    await w.drainAll();
    expect(w.by((r) => r.status !== 'sent').length).toBe(0);
    expect(w.deliveredTotal()).toBe(w.rows.length);
    expect(w.deliveredOn(DAY2)).toBe(waiting);
    expect(w.counted(DAY2)).toBe(waiting);
    expect(w.meter().usedToday).toBe(waiting);
  });

  it('a worker that dies between "provider accepted" and "recorded" neither loses nor double-counts the email', async () => {
    const w = world(`${DAY1}T08:00:00Z`);
    w.queue('signature_request', 'P0_REQUEST', 'u1', 'request:a');
    w.queue('signature_request', 'P0_REQUEST', 'u1', 'request:b');
    w.crashAfterNextSend();
    await expect(w.drainAll()).rejects.toThrow('the worker process is gone');
    // the first email reached the provider but nothing was recorded; the second was claimed and never handled
    expect(w.deliveredOn(DAY1)).toBe(1);
    expect(w.counted(DAY1)).toBe(0);
    expect(w.by((r) => r.status === 'sending').length).toBe(2);

    w.restartWorker();
    await w.drainAll();
    // both are still held by the dead worker's lease, so a new worker must not touch them yet
    expect(w.deliveredOn(DAY1)).toBe(1);
    expect(w.counted(DAY1)).toBe(0);

    w.advance(121_000);
    await w.drainAll();
    // retried with the same key: the provider keeps one copy, and it is counted once
    expect(w.by((r) => r.status === 'sent').length).toBe(2);
    expect(w.deliveredOn(DAY1)).toBe(2);
    expect(w.counted(DAY1)).toBe(2);
    expect(w.meter().usedToday).toBe(2);
  });

  it('new accounts cannot drain the day for everyone else, and one person cannot either', async () => {
    const w = world(`${DAY1}T08:00:00Z`);
    w.restrictedUsers.add('new1').add('new2');
    for (let i = 0; i < 25; i++) w.queue('signature_request', 'P0_REQUEST', 'new1', `n1:${i}`);
    for (let i = 0; i < 25; i++) w.queue('signature_request', 'P0_REQUEST', 'new2', `n2:${i}`);
    for (let i = 0; i < 45; i++) w.queue('signature_request', 'P0_REQUEST', 'big', `big:${i}`);
    for (let i = 0; i < 10; i++) w.queue('signature_request', 'P0_REQUEST', 'u1', `u1:${i}`);
    await w.drainAll();
    const sentBy = (u: string) => w.by((r) => r.sender_user_id === u && r.status === 'sent').length;
    expect(sentBy('new1') + sentBy('new2')).toBe(DEFAULT_BUDGET.restrictedPoolDaily);
    expect(sentBy('big')).toBe(DEFAULT_BUDGET.perUserDaily);
    expect(sentBy('u1')).toBe(10);
    expect(w.by((r) => r.status === 'deferred').length).toBe(20 + 5);
    expect(w.counted(DAY1)).toBe(w.deliveredOn(DAY1));
  });

  it('if the provider itself says the day is over, everything left waits for the reset and the count still matches', async () => {
    const w = world(`${DAY1}T08:00:00Z`, { providerDailyQuota: 12 });
    for (let i = 0; i < 20; i++) w.queue('signature_request', 'P0_REQUEST', senders[i % 6]!, `r:${i}`);
    w.queue('auth_verify', 'P0_AUTH', null, 'auth:x');
    await w.drainAll();
    expect(w.deliveredOn(DAY1)).toBe(12);
    expect(w.counted(DAY1)).toBe(12);
    expect(w.by((r) => r.status === 'deferred').length).toBe(9);
    for (const r of w.by((x) => x.status === 'deferred')) expect(r.notBefore.toISOString()).toBe(`${DAY2}T00:00:00.000Z`);
    expect(w.meter().sharedLeft).toBe(0);
    w.setNow(`${DAY2}T00:00:30Z`);
    await w.drainAll();
    expect(w.by((r) => r.status !== 'sent').length).toBe(0);
    expect(w.deliveredTotal()).toBe(21);
  });
});
