// D-99: which worker may run when the server and this PC share one database.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));

import { FRESH_MS, liveSite, refusal, siteOf } from './lease';

const NOW = Date.parse('2026-11-24T00:10:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('siteOf', () => {
  it('names the site from APP_URL and knows a development address', () => {
    expect(siteOf('https://www.younmesign.com')).toEqual({ site: 'www.younmesign.com', local: false });
    expect(siteOf('http://localhost:3000')).toEqual({ site: 'localhost', local: true });
    expect(siteOf('http://127.0.0.1:3000').local).toBe(true);
    expect(siteOf('http://app.localhost:3000').local).toBe(true);
    expect(siteOf('https://younmesign.test').local).toBe(true);
  });
  it('treats a missing or unreadable APP_URL as this PC (the careful side)', () => {
    expect(siteOf(undefined).local).toBe(true);
    expect(siteOf('').local).toBe(true);
    expect(siteOf('not a url').local).toBe(true);
  });
  it('is not fooled by a live name that merely contains "localhost"', () => {
    expect(siteOf('https://localhost.example.com').local).toBe(false);
  });
});

describe('liveSite', () => {
  it('a fresh heartbeat from the live site blocks a local worker', () => {
    expect(liveSite([{ key: 'worker:www.younmesign.com', updated_at: at(20_000) }], NOW)).toBe('www.younmesign.com');
  });
  it('a stale heartbeat (crashed worker, server off) does not', () => {
    expect(liveSite([{ key: 'worker:www.younmesign.com', updated_at: at(FRESH_MS + 1) }], NOW)).toBeNull();
  });
  it('exactly at the limit counts as stale; just inside it as fresh', () => {
    expect(liveSite([{ key: 'worker:www.younmesign.com', updated_at: at(FRESH_MS) }], NOW)).toBeNull();
    expect(liveSite([{ key: 'worker:www.younmesign.com', updated_at: at(FRESH_MS - 1) }], NOW)).toBe('www.younmesign.com');
  });
  it('no heartbeat, a local one, another kind of key or an unreadable time never block', () => {
    expect(liveSite([], NOW)).toBeNull();
    expect(liveSite([{ key: 'worker:localhost', updated_at: at(1000) }], NOW)).toBeNull();
    expect(liveSite([{ key: 'backup:last', updated_at: at(1000) }], NOW)).toBeNull();
    expect(liveSite([{ key: 'worker:www.younmesign.com', updated_at: 'yesterday' }], NOW)).toBeNull();
  });
  it('finds the live one among several', () => {
    expect(liveSite([{ key: 'worker:localhost', updated_at: at(10) }, { key: 'worker:old.example.com', updated_at: at(FRESH_MS * 5) }, { key: 'worker:www.younmesign.com', updated_at: at(100) }], NOW)).toBe('www.younmesign.com');
  });
});

describe('refusal', () => {
  it('says which site and how to pause it', () => {
    expect(refusal('www.younmesign.com')).toContain('www.younmesign.com');
    expect(refusal('www.younmesign.com')).toContain('npm run server:worker -- pause');
  });
});
