import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { bestText, brandProblem, cleanFooter, contrastRatio, logoType, MIN_CONTRAST, normaliseColor, TEXT_COLOR } from './branding';

describe('workspace branding (D-88)', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    // #777777 on white is about 4.48:1 (just below AA); ratios are rounded down, never up, so it reads 4.47
    expect(contrastRatio('#777777', '#FFFFFF')).toBeGreaterThanOrEqual(4.47);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
    expect(contrastRatio('#1A1818', '#FFFFFF')).toBeGreaterThan(17);
  });

  it('blocks unreadable combinations and says what would work', () => {
    expect(brandProblem('#2F5D50', 'light')).toBeNull();
    expect(brandProblem('#FFD400', 'dark')).toBeNull();
    expect(brandProblem('#FFD400', 'light')).toMatch(/hard to read.*Dark text would work/);
    expect(brandProblem('#2F5D50', 'dark')).toMatch(/hard to read.*Light text would work/);
    expect(brandProblem('#777777', 'light')).toMatch(/hard to read/);
    expect(brandProblem('red', 'light')).toMatch(/six hexadecimal digits/);
    expect(brandProblem('#12345', 'light')).toMatch(/six hexadecimal digits/);
  });

  it('every accepted colour really is readable, and some text colour is suggested for every colour', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), fc.constantFrom<'light' | 'dark'>('light', 'dark'), (n, text) => {
        const c = `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
        if (brandProblem(c, text) === null) expect(contrastRatio(c, TEXT_COLOR[text])).toBeGreaterThanOrEqual(MIN_CONTRAST);
        expect(['light', 'dark']).toContain(bestText(c));
      }),
      { numRuns: 500 },
    );
  });

  it('normalises colours and footers', () => {
    expect(normaliseColor(' #2f5d50 ')).toBe('#2F5D50');
    expect(normaliseColor('#2f5d5')).toBeNull();
    expect(cleanFooter('Acme Ltd\r\nRegistered in X\u0000\u0007\n\n\n\nThanks')).toBe('Acme Ltd\nRegistered in X\n\nThanks');
    expect(cleanFooter('x'.repeat(900)).length).toBe(500);
  });

  it('accepts only real PNG and JPEG files, by their first bytes', () => {
    expect(logoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(logoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(logoType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(logoType(new Uint8Array([]))).toBeNull();
  });
});
