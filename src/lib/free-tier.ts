// Free-tier limits and how close the platform is to them (brief: check:budget; AT1.13).
// Pure, with no imports, so the command-line check (scripts/check-budget.mjs) and the app use the same code.
// The numbers are the ones recorded in docs/FREE_TIER_BUDGET.md (verified on the vendors' pages on 2026-11-17).

export interface PlatformUsage {
  dbBytes: number;
  storageBytes: number;
  userCount: number;
  emailsToday: number;
  emailsMonth: number;
}

export const FREE_LIMITS = {
  dbBytes: 500 * 1024 * 1024, // Supabase Free: database 500 MB
  storageBytes: 1024 * 1024 * 1024, // Supabase Free: file storage 1 GB
  userCount: 50_000, // Supabase Free: monthly active users (all registered users are counted here, which over-counts)
  emailsToday: 100, // Resend Free: emails per day
  emailsMonth: 3000, // Resend Free: emails per month
} as const;

/** warn from 70%, fail the phase verification above 80%, refuse new sign-ups and uploads from 90%. */
export const THRESHOLDS = { warn: 0.7, fail: 0.8, block: 0.9 } as const;

export type Level = 'ok' | 'warn' | 'fail' | 'block';
export interface Metric {
  key: keyof PlatformUsage;
  label: string;
  used: number;
  limit: number;
  /** share of the limit, 0 to 1 and beyond */
  share: number;
  level: Level;
  /** how to print the two numbers */
  unit: 'bytes' | 'count';
}

const LABELS: Record<keyof PlatformUsage, [string, 'bytes' | 'count']> = {
  dbBytes: ['Database size', 'bytes'],
  storageBytes: ['Stored files', 'bytes'],
  userCount: ['Registered users', 'count'],
  emailsToday: ['Emails sent today', 'count'],
  emailsMonth: ['Emails sent this month', 'count'],
};

export function levelFor(share: number): Level {
  if (!Number.isFinite(share) || share >= THRESHOLDS.block) return 'block';
  if (share > THRESHOLDS.fail) return 'fail';
  if (share >= THRESHOLDS.warn) return 'warn';
  return 'ok';
}

export function assess(usage: PlatformUsage): Metric[] {
  return (Object.keys(LABELS) as (keyof PlatformUsage)[]).map((key) => {
    const used = Math.max(0, Number(usage[key]));
    const limit = FREE_LIMITS[key];
    const share = used / limit;
    return { key, label: LABELS[key][0], unit: LABELS[key][1], used, limit, share, level: levelFor(share) };
  });
}

/** The phase verification fails when anything is above 80% of its free limit. */
export const verificationFails = (metrics: Metric[]) => metrics.some((m) => m.level === 'fail' || m.level === 'block');

/**
 * New sign-ups and uploads are refused, politely, once the database, the file storage or the user count
 * reaches 90% of its limit. Email is not part of this: the Email Budget Manager already handles email.
 */
export function capacityBlock(usage: PlatformUsage): { blocked: false } | { blocked: true; message: string } {
  const full = assess(usage).filter((m) => m.level === 'block' && (m.key === 'dbBytes' || m.key === 'storageBytes' || m.key === 'userCount'));
  if (full.length === 0) return { blocked: false };
  return {
    blocked: true,
    message: 'EasySign is close to the limit of its free hosting plan, so this is switched off for the moment. Nothing you already have is affected. Please try again later, or contact the administrator.',
  };
}

export function formatAmount(n: number, unit: 'bytes' | 'count'): string {
  if (unit === 'count') return String(Math.round(n));
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
