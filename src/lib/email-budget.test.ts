import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_BUDGET, allowanceFor, decide, meter, nextUtcMidnight, emptyState, record, type BudgetState, type EmailClass } from './email-budget';

const day = (over: Partial<BudgetState> = {}): BudgetState => ({ ...emptyState(15), ...over });
const send = (s: BudgetState, cls: EmailClass, opts = {}) => {
  const d = decide(cls, s, DEFAULT_BUDGET, opts);
  return d.action === 'send' ? { state: record(s, cls, opts), sent: true } : { state: s, sent: false };
};

describe('email budget manager', () => {
  it('default constants match DECISIONS D-27', () => {
    expect(DEFAULT_BUDGET.dailyCap).toBe(100);
    expect(DEFAULT_BUDGET.monthlyCap).toBe(3000);
    expect(DEFAULT_BUDGET.authReserveDaily).toBe(15);
    expect(DEFAULT_BUDGET.cutoffs).toEqual({ P3: 0.6, P2: 0.75, P1: 0.9, P0_REQUEST: 1 });
    expect(DEFAULT_BUDGET.restrictedPoolDaily).toBe(30);
  });

  it('on a fresh day everything sends', () => {
    for (const cls of ['P0_AUTH', 'P0_REQUEST', 'P1', 'P2', 'P3'] as EmailClass[]) {
      expect(decide(cls, day(), DEFAULT_BUDGET).action).toBe('send');
    }
  });

  it('AT1.11: under a 100/day cap P3 defers first, then P2, then P1, then requests; auth reserve survives', () => {
    let s = day();
    const firstDeferral: Partial<Record<EmailClass, number>> = {};
    // Push shared traffic one email at a time, probing every class before each send.
    for (let i = 0; i < 200; i++) {
      for (const cls of ['P3', 'P2', 'P1', 'P0_REQUEST'] as EmailClass[]) {
        if (firstDeferral[cls] === undefined && decide(cls, s, DEFAULT_BUDGET).action === 'defer') {
          firstDeferral[cls] = s.sentTodayShared;
        }
      }
      const r = send(s, 'P0_REQUEST');
      if (!r.sent) break;
      s = r.state;
    }
    // shared pool = 100 - 15 = 85 → cut-offs at floor(85*0.6)=51, floor(85*0.75)=63, floor(85*0.9)=76, 85
    expect(firstDeferral).toEqual({ P3: 51, P2: 63, P1: 76, P0_REQUEST: 85 });
    expect(s.sentTodayShared).toBe(85);

    // The auth reserve is untouched: exactly 15 auth emails still go out, the 16th defers.
    let authSent = 0;
    for (let i = 0; i < 30; i++) {
      const r = send(s, 'P0_AUTH');
      if (!r.sent) break;
      s = r.state;
      authSent++;
    }
    expect(authSent).toBe(15);
    expect(s.sentTodayShared + s.sentTodayAuth).toBe(100);
    expect(decide('P0_AUTH', s, DEFAULT_BUDGET)).toMatchObject({ action: 'defer' });
  });

  it('auth may spill into the shared pool, and that shrinks what is left for others', () => {
    let s = day();
    for (let i = 0; i < 40; i++) s = send(s, 'P0_AUTH').state; // 15 reserve + 25 from shared
    expect(s.sentTodayAuth).toBe(40);
    const m = meter(s, DEFAULT_BUDGET);
    expect(m.sharedPool).toBe(85);
    expect(m.sharedLeft).toBe(60);
    let requests = 0;
    for (let i = 0; i < 100; i++) {
      const r = send(s, 'P0_REQUEST');
      if (!r.sent) break;
      s = r.state;
      requests++;
    }
    expect(requests).toBe(60);
    expect(s.sentTodayAuth + s.sentTodayShared).toBe(100);
  });

  it('a deferral is never a drop: it carries the next UTC midnight and a plain-language reason', () => {
    const s = day({ sentTodayShared: 85 });
    const now = new Date('2026-11-17T22:15:00Z');
    const d = decide('P1', s, DEFAULT_BUDGET, { now });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') {
      expect(d.notBefore.toISOString()).toBe('2026-11-18T00:00:00.000Z');
      expect(d.reason).toMatch(/limit/i);
    }
  });

  it('nextUtcMidnight ignores the local timezone', () => {
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-11-17T00:00:00Z')).toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('restricted accounts share a small pool and cannot drain the day', () => {
    let s = day();
    let sent = 0;
    for (let i = 0; i < 100; i++) {
      const r = send(s, 'P0_REQUEST', { restrictedSender: true, userSentToday: 0 });
      if (!r.sent) break;
      s = r.state;
      sent++;
    }
    expect(sent).toBe(30);
    // trusted senders are unaffected
    expect(decide('P0_REQUEST', s, DEFAULT_BUDGET, { restrictedSender: false }).action).toBe('send');
  });

  it('per-user daily cap applies to non-auth mail', () => {
    const s = day();
    expect(decide('P0_REQUEST', s, DEFAULT_BUDGET, { userSentToday: DEFAULT_BUDGET.perUserDaily }).action).toBe('defer');
    expect(decide('P0_AUTH', s, DEFAULT_BUDGET, { userSentToday: DEFAULT_BUDGET.perUserDaily }).action).toBe('send');
  });

  it('monthly pacing: late in a heavy month the daily allowance shrinks below 100', () => {
    // 2,900 already sent before today, 5 days left (incl. today) → allowance floor(100/5) = 20/day
    const s = day({ sentMonthBeforeToday: 2900, daysLeftInMonth: 5 });
    const m = meter(s, DEFAULT_BUDGET);
    expect(m.dailyAllowance).toBe(20);
    expect(m.authReserve).toBe(15);
    expect(m.sharedPool).toBe(5);
    let st = s;
    let n = 0;
    for (let i = 0; i < 50; i++) {
      const r = send(st, 'P0_REQUEST');
      if (!r.sent) break;
      st = r.state;
      n++;
    }
    expect(n).toBe(5);
  });

  it('when the month is exhausted nothing sends, not even auth', () => {
    const s = day({ sentMonthBeforeToday: 3000, daysLeftInMonth: 3 });
    expect(decide('P0_AUTH', s, DEFAULT_BUDGET).action).toBe('defer');
    expect(decide('P0_REQUEST', s, DEFAULT_BUDGET).action).toBe('defer');
  });

  it('meter reports what a sender needs to see', () => {
    const m = meter(day({ sentTodayShared: 60, sentTodayAuth: 3 }), DEFAULT_BUDGET, new Date('2026-11-17T12:00:00Z'));
    expect(m).toMatchObject({ sharedPool: 85, sharedLeft: 25, authLeft: 12, low: true, usedToday: 63 });
    expect(m.resetsAt.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(meter(day(), DEFAULT_BUDGET).low).toBe(false);
  });

  it('the allowance shown to a sender names the limit that binds them', () => {
    expect(allowanceFor('P0_REQUEST', day())).toEqual({ left: 40, limitedBy: 'you' });
    expect(allowanceFor('P0_REQUEST', day(), DEFAULT_BUDGET, { restrictedSender: true })).toEqual({ left: 30, limitedBy: 'new-accounts' });
    expect(allowanceFor('P0_REQUEST', day({ sentTodayShared: 70 }), DEFAULT_BUDGET, { userSentToday: 5 })).toEqual({ left: 15, limitedBy: 'day' });
    expect(allowanceFor('P1', day({ sentTodayShared: 70 }))).toEqual({ left: 6, limitedBy: 'day' });
    expect(allowanceFor('P3', day({ sentTodayShared: 70 }))).toEqual({ left: 0, limitedBy: 'day' });
    expect(allowanceFor('P0_REQUEST', day({ sentTodayShared: 10, restrictedSentToday: 30 }), DEFAULT_BUDGET, { restrictedSender: true })).toEqual({ left: 0, limitedBy: 'new-accounts' });
    expect(allowanceFor('P0_REQUEST', record(day(), 'PROVIDER_DAILY_LIMIT'))).toEqual({ left: 0, limitedBy: 'day' });
    expect(allowanceFor('P0_REQUEST', day({ sentMonthBeforeToday: 3000 }))).toEqual({ left: 0, limitedBy: 'month' });
  });

  it('property: the allowance is above zero exactly when the budget manager would send', () => {
    fc.assert(
      fc.property(
        fc.record({
          sentTodayAuth: fc.integer({ min: 0, max: 40 }),
          sentTodayShared: fc.integer({ min: 0, max: 110 }),
          sentMonthBeforeToday: fc.integer({ min: 0, max: 3100 }),
          daysLeftInMonth: fc.integer({ min: 1, max: 31 }),
          restrictedSentToday: fc.integer({ min: 0, max: 40 }),
          providerClosed: fc.boolean(),
        }),
        fc.constantFrom('P0_REQUEST', 'P1', 'P2', 'P3') as fc.Arbitrary<Exclude<EmailClass, 'P0_AUTH'>>,
        fc.boolean(),
        fc.integer({ min: 0, max: 50 }),
        (s, cls, restrictedSender, userSentToday) => {
          const opts = { restrictedSender, userSentToday };
          const a = allowanceFor(cls, s, DEFAULT_BUDGET, opts);
          expect(a.left).toBeGreaterThanOrEqual(0);
          expect(a.left > 0).toBe(decide(cls, s, DEFAULT_BUDGET, opts).action === 'send');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a provider 429 snaps the day shut', () => {
    const s = record(day({ sentTodayShared: 10 }), 'PROVIDER_DAILY_LIMIT');
    expect(decide('P0_REQUEST', s, DEFAULT_BUDGET).action).toBe('defer');
    expect(decide('P0_AUTH', s, DEFAULT_BUDGET).action).toBe('defer');
  });
});
