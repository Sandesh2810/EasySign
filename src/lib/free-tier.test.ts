import { describe, it, expect } from 'vitest';
import { assess, capacityBlock, FREE_LIMITS, formatAmount, levelFor, verificationFails, type PlatformUsage } from './free-tier';

const usage = (over: Partial<PlatformUsage> = {}): PlatformUsage => ({ dbBytes: 20 * 1024 * 1024, storageBytes: 5 * 1024 * 1024, userCount: 12, emailsToday: 3, emailsMonth: 40, ...over });

describe('free-tier budget check', () => {
  it('uses the limits recorded in FREE_TIER_BUDGET.md', () => {
    expect(FREE_LIMITS).toEqual({ dbBytes: 524288000, storageBytes: 1073741824, userCount: 50000, emailsToday: 100, emailsMonth: 3000 });
  });

  it('warns from 70%, fails above 80%, blocks from 90%', () => {
    expect(levelFor(0)).toBe('ok');
    expect(levelFor(0.699)).toBe('ok');
    expect(levelFor(0.7)).toBe('warn');
    expect(levelFor(0.8)).toBe('warn'); // "exceeds 80%" fails; exactly 80% does not
    expect(levelFor(0.801)).toBe('fail');
    expect(levelFor(0.9)).toBe('block');
    expect(levelFor(1.7)).toBe('block');
    expect(levelFor(Number.NaN)).toBe('block'); // an unreadable number is never "fine"
  });

  it('reports every metric against its own limit', () => {
    const m = assess(usage({ dbBytes: 400 * 1024 * 1024, emailsToday: 75 }));
    expect(m.map((x) => x.key)).toEqual(['dbBytes', 'storageBytes', 'userCount', 'emailsToday', 'emailsMonth']);
    expect(m.find((x) => x.key === 'dbBytes')).toMatchObject({ level: 'warn', limit: FREE_LIMITS.dbBytes });
    expect(m.find((x) => x.key === 'emailsToday')).toMatchObject({ level: 'warn', used: 75, limit: 100 });
    expect(m.find((x) => x.key === 'userCount')?.level).toBe('ok');
  });

  it('the phase verification fails only above 80%', () => {
    expect(verificationFails(assess(usage()))).toBe(false);
    expect(verificationFails(assess(usage({ emailsMonth: 2400 })))).toBe(false); // exactly 80%
    expect(verificationFails(assess(usage({ emailsMonth: 2401 })))).toBe(true);
    expect(verificationFails(assess(usage({ storageBytes: 1000 * 1024 * 1024 })))).toBe(true);
  });

  it('refuses new sign-ups and uploads at 90% of database, storage or users, but not because of email', () => {
    expect(capacityBlock(usage())).toEqual({ blocked: false });
    expect(capacityBlock(usage({ emailsToday: 100, emailsMonth: 3000 }))).toEqual({ blocked: false }); // the email manager handles email
    expect(capacityBlock(usage({ dbBytes: 449 * 1024 * 1024 }))).toEqual({ blocked: false });
    const full = capacityBlock(usage({ dbBytes: 450 * 1024 * 1024 }));
    expect(full.blocked).toBe(true);
    expect(full.blocked && full.message).toContain('Nothing you already have is affected');
    expect(capacityBlock(usage({ storageBytes: 0.95 * 1024 * 1024 * 1024 })).blocked).toBe(true);
    expect(capacityBlock(usage({ userCount: 45_000 })).blocked).toBe(true);
  });

  it('prints sizes and counts readably', () => {
    expect(formatAmount(20 * 1024 * 1024, 'bytes')).toBe('20.0 MB');
    expect(formatAmount(1.5 * 1024 * 1024 * 1024, 'bytes')).toBe('1.50 GB');
    expect(formatAmount(42, 'count')).toBe('42');
  });
});
