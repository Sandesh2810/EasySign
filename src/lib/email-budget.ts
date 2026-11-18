// Email Budget Manager: pure decision logic (DECISIONS D-27). No I/O here; the worker supplies
// counters from the email_budget table and persists the outcome.
// Day boundary is the UTC calendar day because that is when the provider resets.

export type EmailClass = 'P0_AUTH' | 'P0_REQUEST' | 'P1' | 'P2' | 'P3';

export interface BudgetConfig {
  dailyCap: number;
  monthlyCap: number;
  /** Daily sends only auth/OTP mail may use. */
  authReserveDaily: number;
  /** Held back each month so logins keep working to month end. */
  authReserveMonthly: number;
  /** Fraction of the shared pool at which each class stops sending. */
  cutoffs: Record<Exclude<EmailClass, 'P0_AUTH'>, number>;
  /** Combined daily ceiling for all restricted (new) accounts. */
  restrictedPoolDaily: number;
  perUserDaily: number;
  /** The meter flags "low" once this share of the shared pool is used. */
  lowAt: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyCap: 100,
  monthlyCap: 3000,
  authReserveDaily: 15,
  authReserveMonthly: 150,
  cutoffs: { P3: 0.6, P2: 0.75, P1: 0.9, P0_REQUEST: 1 },
  restrictedPoolDaily: 30,
  perUserDaily: 40,
  lowAt: 0.7,
};

export interface BudgetState {
  sentTodayAuth: number;
  /** Everything that is not auth/OTP. */
  sentTodayShared: number;
  sentMonthBeforeToday: number;
  /** Days left in the UTC month, counting today. */
  daysLeftInMonth: number;
  restrictedSentToday: number;
  /** Set when the provider itself reported the daily quota as exhausted. */
  providerClosed: boolean;
}

export interface SendOptions {
  restrictedSender?: boolean;
  userSentToday?: number;
  now?: Date;
}

export type Decision = { action: 'send' } | { action: 'defer'; notBefore: Date; reason: string };

export const emptyState = (daysLeftInMonth: number): BudgetState => ({
  sentTodayAuth: 0,
  sentTodayShared: 0,
  sentMonthBeforeToday: 0,
  daysLeftInMonth,
  restrictedSentToday: 0,
  providerClosed: false,
});

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function pools(s: BudgetState, cfg: BudgetConfig) {
  const days = Math.max(1, s.daysLeftInMonth);
  const monthLeftAtStartOfDay = Math.max(0, cfg.monthlyCap - s.sentMonthBeforeToday);
  const dailyAllowance = Math.max(0, Math.min(cfg.dailyCap, Math.floor(monthLeftAtStartOfDay / days)));
  const authReserve = Math.min(cfg.authReserveDaily, dailyAllowance);
  const sharedPool = dailyAllowance - authReserve;
  const authSpill = Math.max(0, s.sentTodayAuth - authReserve);
  const sharedUsed = s.sentTodayShared + authSpill;
  const usedToday = s.sentTodayAuth + s.sentTodayShared;
  const futureAuthHold = Math.min(cfg.authReserveMonthly, cfg.authReserveDaily * (days - 1));
  const monthLeftForShared = monthLeftAtStartOfDay - usedToday - futureAuthHold;
  return { dailyAllowance, authReserve, sharedPool, sharedUsed, usedToday, monthLeftForShared };
}

const REASONS = {
  day: 'Email limit reached for today. This will send after the daily reset, or you can copy the link now.',
  month: 'Monthly email limit reached. This will send when the limit resets, or you can copy the link now.',
  user: 'You have reached your personal email limit for today. This will send tomorrow, or you can copy the link now.',
  restricted: 'New accounts share a small daily email limit, and it has been reached. This will send tomorrow, or you can copy the link now.',
} as const;

export function decide(cls: EmailClass, s: BudgetState, cfg: BudgetConfig = DEFAULT_BUDGET, opts: SendOptions = {}): Decision {
  const defer = (reason: string): Decision => ({ action: 'defer', notBefore: nextUtcMidnight(opts.now ?? new Date()), reason });
  const p = pools(s, cfg);

  if (s.providerClosed) return defer(REASONS.day);
  if (p.dailyAllowance <= 0) return defer(REASONS.month);

  if (cls === 'P0_AUTH') return p.usedToday < p.dailyAllowance ? { action: 'send' } : defer(REASONS.day);

  if (p.sharedUsed >= Math.floor(p.sharedPool * cfg.cutoffs[cls])) return defer(REASONS.day);
  if (p.monthLeftForShared <= 0) return defer(REASONS.month);
  if (opts.restrictedSender && s.restrictedSentToday >= cfg.restrictedPoolDaily) return defer(REASONS.restricted);
  if ((opts.userSentToday ?? 0) >= cfg.perUserDaily) return defer(REASONS.user);
  return { action: 'send' };
}

/** Return the state after a send (or after the provider said the day is over). Pure. */
export function record(s: BudgetState, event: EmailClass | 'PROVIDER_DAILY_LIMIT', opts: SendOptions = {}): BudgetState {
  if (event === 'PROVIDER_DAILY_LIMIT') return { ...s, providerClosed: true };
  if (event === 'P0_AUTH') return { ...s, sentTodayAuth: s.sentTodayAuth + 1 };
  return {
    ...s,
    sentTodayShared: s.sentTodayShared + 1,
    restrictedSentToday: s.restrictedSentToday + (opts.restrictedSender ? 1 : 0),
  };
}

export type AllowanceLimit = 'day' | 'month' | 'new-accounts' | 'you';

/**
 * How many more emails of one class this sender could have sent right now, and what is holding the
 * number down. It agrees with decide(): the count is above zero exactly when decide() says "send".
 */
export function allowanceFor(
  cls: Exclude<EmailClass, 'P0_AUTH'>,
  s: BudgetState,
  cfg: BudgetConfig = DEFAULT_BUDGET,
  opts: SendOptions = {},
): { left: number; limitedBy: AllowanceLimit } {
  const p = pools(s, cfg);
  if (s.providerClosed) return { left: 0, limitedBy: 'day' };
  if (p.dailyAllowance <= 0) return { left: 0, limitedBy: 'month' };
  const candidates: [AllowanceLimit, number][] = [
    ['day', Math.floor(p.sharedPool * cfg.cutoffs[cls]) - p.sharedUsed],
    ['month', p.monthLeftForShared],
    ['you', cfg.perUserDaily - (opts.userSentToday ?? 0)],
  ];
  if (opts.restrictedSender) candidates.push(['new-accounts', cfg.restrictedPoolDaily - s.restrictedSentToday]);
  // the tightest limit wins; on a tie the earlier entry (the more general limit) is named
  const [limitedBy, left] = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { left: Math.max(0, left), limitedBy };
}

export interface Meter {
  dailyAllowance: number;
  authReserve: number;
  sharedPool: number;
  /** Emails senders can still send today (requests and copies). */
  sharedLeft: number;
  authLeft: number;
  usedToday: number;
  low: boolean;
  resetsAt: Date;
}

export function meter(s: BudgetState, cfg: BudgetConfig = DEFAULT_BUDGET, now: Date = new Date()): Meter {
  const p = pools(s, cfg);
  const closed = s.providerClosed;
  const sharedLeft = closed ? 0 : Math.max(0, Math.min(p.sharedPool - p.sharedUsed, p.monthLeftForShared));
  const authLeft = closed ? 0 : Math.max(0, Math.min(p.authReserve - s.sentTodayAuth, p.dailyAllowance - p.usedToday));
  return {
    dailyAllowance: p.dailyAllowance,
    authReserve: p.authReserve,
    sharedPool: p.sharedPool,
    sharedLeft,
    authLeft,
    usedToday: p.usedToday,
    low: p.sharedPool === 0 || 1 - sharedLeft / p.sharedPool >= cfg.lowAt,
    resetsAt: nextUtcMidnight(now),
  };
}
