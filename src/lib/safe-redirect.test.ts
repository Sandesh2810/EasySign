import { describe, it, expect } from 'vitest';
import { safeNext } from './safe-redirect';

describe('safeNext (open-redirect protection)', () => {
  it('keeps ordinary in-app paths, with query and hash', () => {
    expect(safeNext('/app')).toBe('/app');
    expect(safeNext('/app/envelopes/123?tab=fields#top')).toBe('/app/envelopes/123?tab=fields#top');
  });
  it('falls back for anything that could leave the site', () => {
    for (const bad of [
      'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'evil', '', null, undefined,
      '/app\\..\\x', '/\u0000', 'http:/evil', '///evil.example/x', '/' + 'a'.repeat(600),
    ]) {
      expect(safeNext(bad as string)).toBe('/app');
    }
  });
  it('normalises dot segments instead of trusting them', () => {
    expect(safeNext('/app/../admin')).toBe('/admin');
    expect(safeNext('/a/./b')).toBe('/a/b');
  });
  it('accepts a custom fallback', () => {
    expect(safeNext('https://evil.example', '/login')).toBe('/login');
  });
});
