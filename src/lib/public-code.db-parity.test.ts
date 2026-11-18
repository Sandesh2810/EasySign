import { describe, it, expect } from 'vitest';
import { isValidPublicCode, normalisePublicCode } from './public-code';

// Codes produced by the DATABASE generator (app_private.gen_public_code) during the SQL test run of
// 2026-11-17. The database and this module implement the same check algorithm independently; if they
// ever drift, codes printed on documents would stop validating on /verify. This fixture pins parity.
const FROM_DATABASE = [
  'ES-2611-QR2S-WZPC-4YEW-H9',
  'ES-2611-XVTT-R2JF-AR8H-FG',
  'ES-2611-Y9NC-3S1B-X7YH-SV',
  'ES-2611-YQHG-JW7B-F79A-DK',
  'ES-2611-AENB-VDDY-ZSHZ-F9',
];

describe('public code: database and application agree', () => {
  it.each(FROM_DATABASE)('%s (generated in Postgres) validates in the application', (code) => {
    expect(normalisePublicCode(code)).toBe(code);
    expect(isValidPublicCode(code)).toBe(true);
  });

  it('a one-symbol change to a database code is rejected', () => {
    expect(isValidPublicCode('ES-2611-QR2S-WZPC-4YEW-H8')).toBe(false);
    expect(isValidPublicCode('ES-2611-QR2S-WZPC-4YEX-H9')).toBe(false);
  });
});
