// D-94: usage wording, the monthly reset, and the free plan's values agreeing between the migration and the code.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { API_RATE, secondsToNextMonth } from './api/limits';
import { bytesInWords, monthInWords, ofLimit, usageLines, type Usage } from './usage';

describe('usage wording', () => {
  it('sizes in bytes, KB, MB, GB', () => {
    expect(bytesInWords(0)).toBe('0 bytes');
    expect(bytesInWords(980)).toBe('980 bytes');
    expect(bytesInWords(12_345)).toBe('12.3 KB');
    expect(bytesInWords(1_500)).toBe('1.5 KB');
    expect(bytesInWords(13_509_940)).toBe('13.5 MB');
    expect(bytesInWords(250_000_000)).toBe('250 MB');
    expect(bytesInWords(1_020_000_000)).toBe('1.02 GB');
  });
  it('used against a limit, or without one', () => {
    expect(ofLimit(3, 10)).toBe('3 of 10');
    expect(ofLimit(1204, null)).toBe('1,204 (no limit)');
  });
  it('months in words', () => {
    expect(monthInWords('2026-11')).toBe('November 2026');
    expect(monthInWords('nonsense')).toBe('nonsense');
  });
  it('the lines shown on Settings', () => {
    const u: Usage = {
      month: '2026-11',
      plan: { id: 'free', name: 'Free', max_api_keys: 10, max_webhook_endpoints: 10, api_requests_per_minute: 60, monthly_api_calls: null },
      documents_sent: 12, people_sent_to: 30, api_calls: 1204, storage_bytes: 13_509_940, members: 3, api_keys: 2, webhook_endpoints: 1,
    };
    expect(usageLines(u).map((l) => `${l.label}: ${l.value}`)).toEqual([
      'Documents sent: 12', 'People sent to: 30', 'API requests: 1,204 (no limit)', 'Storage in use now: 13.5 MB', 'Active members: 3',
      'API keys: 2 of 10', 'Webhook endpoints: 1 of 10', 'API requests a minute, per key: up to 60',
    ]);
  });
});

describe('monthly reset', () => {
  it('counts the seconds to the first of next month, UTC', () => {
    expect(secondsToNextMonth(new Date('2026-11-30T23:59:00Z'))).toBe(60);
    expect(secondsToNextMonth(new Date('2026-12-31T23:00:00Z'))).toBe(3600);
    expect(secondsToNextMonth(new Date('2026-02-01T00:00:00Z'))).toBe(28 * 86400);
  });
});

describe('the free plan', () => {
  it('has the same per-minute limit in the migration as in the code and the documentation', () => {
    const sql = readFileSync(path.join(process.cwd(), 'supabase', 'migrations', '20261121193911_plans_usage.sql'), 'utf8');
    const free = /\('free', 'Free', true, (\d+), (\d+), (\d+), (null|\d+),/.exec(sql);
    expect(free).not.toBeNull();
    expect(Number(free![3])).toBe(API_RATE.limit);
    expect(free![1]).toBe('10');
    expect(free![2]).toBe('10');
    expect(free![4]).toBe('null');
  });
});
