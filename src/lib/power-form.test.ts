import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkFormToken, formToken, newFormSlug, MAX_FILL_SECONDS, MIN_FILL_SECONDS, SLUG } from './power-form';

const KEY = 'k'.repeat(48);

describe('public form links (D-87)', () => {
  it('a link code is 22 URL-safe characters and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = newFormSlug();
      expect(s).toMatch(SLUG);
      seen.add(s);
    }
    expect(seen.size).toBe(500);
  });

  it('a submission must come from the page, after a human pause, before the page is too old', () => {
    const t0 = 1_800_000_000_000;
    const tok = formToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', t0);
    expect(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', tok, t0 + 500)).toBe('too_fast');
    expect(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', tok, t0 + MIN_FILL_SECONDS * 1000 + 1)).toBe('ok');
    expect(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', tok, t0 + (MAX_FILL_SECONDS + 1) * 1000)).toBe('expired');
    // for another form, with another key, or tampered with: refused
    expect(checkFormToken(KEY, 'BBBBBBBBBBBBBBBBBBBB02', tok, t0 + 10_000)).toBe('invalid');
    expect(checkFormToken('x'.repeat(48), 'AAAAAAAAAAAAAAAAAAAA01', tok, t0 + 10_000)).toBe('invalid');
    const [issued, sig] = tok.split('.');
    expect(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', `${Number(issued) - 100}.${sig}`, t0 + 10_000)).toBe('invalid');
    expect(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', undefined, t0)).toBe('invalid');
  });

  it('never throws on anything sent to it', () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        expect(['ok', 'invalid', 'too_fast', 'expired']).toContain(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', junk));
        expect(checkFormToken(KEY, 'AAAAAAAAAAAAAAAAAAAA01', junk)).not.toBe('ok');
      }),
      { numRuns: 200 },
    );
  });
});
