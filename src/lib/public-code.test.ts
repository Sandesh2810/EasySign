import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALPHABET, generatePublicCode, normalisePublicCode, isValidPublicCode, signatureId } from './public-code';

const FORMAT = /^ES-\d{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/;

describe('public code', () => {
  it('alphabet is Crockford base32 without I, L, O, U', () => {
    expect(ALPHABET).toHaveLength(32);
    expect(new Set(ALPHABET).size).toBe(32);
    for (const c of 'ILOU') expect(ALPHABET).not.toContain(c);
  });

  it('has the documented format and embeds YYMM in UTC', () => {
    const code = generatePublicCode(new Date(Date.UTC(2026, 10, 17)));
    expect(code).toMatch(FORMAT);
    expect(code.slice(3, 7)).toBe('2611');
  });

  it('a generated code validates', () => {
    for (let i = 0; i < 200; i++) expect(isValidPublicCode(generatePublicCode())).toBe(true);
  });

  it('uses the injected random source and nothing else (deterministic with a fixed source)', () => {
    const fixed = () => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const d = new Date(Date.UTC(2027, 0, 5));
    expect(generatePublicCode(d, fixed)).toBe(generatePublicCode(d, fixed));
    expect(generatePublicCode(d, fixed)).not.toBe(generatePublicCode(d, () => Buffer.from([8, 7, 6, 5, 4, 3, 2, 1])));
  });

  it('source file never references Math.random', () => {
    const src = readFileSync(path.join(__dirname, 'public-code.ts'), 'utf8');
    expect(src).not.toMatch(/Math\.random/);
    expect(src).toMatch(/randomBytes/);
  });

  it('AT1.8: 100,000 codes, zero collisions, all well-formed', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      const c = generatePublicCode();
      if (i % 997 === 0) expect(c).toMatch(FORMAT);
      seen.add(c);
    }
    expect(seen.size).toBe(100_000);
  });

  it('check symbols catch single-character substitutions in the payload and the date', () => {
    // A 10-bit check misses a random change with probability 1/1024.
    // Of 5,000 single-symbol payload mutations at most 0.5% may slip through (expected ~0.1%).
    let slipped = 0;
    for (let i = 0; i < 5000; i++) {
      const compact = generatePublicCode().replace(/-/g, '');
      const idx = 6 + (i % 12);
      const replacement = ALPHABET[(ALPHABET.indexOf(compact[idx]) + 1 + (i % 31)) % 32];
      if (replacement === compact[idx]) continue;
      if (isValidPublicCode(compact.slice(0, idx) + replacement + compact.slice(idx + 1))) slipped++;
    }
    expect(slipped).toBeLessThanOrEqual(25);

    // The month is covered by the check too: changing YYMM invalidates almost every code.
    let dateSlipped = 0;
    for (let i = 0; i < 2000; i++) {
      const code = generatePublicCode(new Date(Date.UTC(2026, 10, 1)));
      if (isValidPublicCode(code.replace('ES-2611', 'ES-2612'))) dateSlipped++;
    }
    expect(dateSlipped).toBeLessThanOrEqual(10);
  });

  it('property: any generated code survives normalisation unchanged and validates', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 8, maxLength: 8 }), fc.integer({ min: 2026, max: 2099 }), fc.integer({ min: 0, max: 11 }), (bytes, y, m) => {
        const code = generatePublicCode(new Date(Date.UTC(y, m, 15)), () => Buffer.from(bytes));
        return normalisePublicCode(code) === code && isValidPublicCode(code);
      }),
    );
  });

  it('normalises what people type', () => {
    const code = generatePublicCode();
    const messy = ' ' + code.toLowerCase().replace(/-/g, ' ') + ' ';
    expect(normalisePublicCode(messy)).toBe(code);
    expect(normalisePublicCode(code.replace(/-/g, ''))).toBe(code);
  });

  it('maps look-alike letters: O to 0, I and L to 1', () => {
    expect(normalisePublicCode('ES-2611-O0O0-I1L1-0000-00')).toBe('ES-2611-0000-1111-0000-00');
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'ES', 'XX-2611-0000-0000-0000-00', 'ES-26AA-0000-0000-0000-00', 'ES-2611-UUUU-0000-0000-00', 'ES-2611-0000-0000-0000', 'ES-2611-0000-0000-0000-000']) {
      expect(normalisePublicCode(bad)).toBeNull();
      expect(isValidPublicCode(bad)).toBe(false);
    }
  });

  it('signature ids are code-S<n>, n >= 1', () => {
    const code = generatePublicCode();
    expect(signatureId(code, 1)).toBe(`${code}-S1`);
    expect(signatureId(code, 12)).toBe(`${code}-S12`);
    expect(() => signatureId(code, 0)).toThrow();
    expect(() => signatureId(code, 1.5)).toThrow();
  });
});
