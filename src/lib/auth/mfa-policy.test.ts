import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ADMIN_MFA_FRESH_SECONDS,
  generateRecoveryCodes,
  hashRecoveryCode,
  isAuthenticatorCode,
  lastAuthenticatorCheck,
  mfaGate,
  normaliseRecoveryCode,
  safeNext,
} from './mfa-policy';

const NOW = 1_800_000_000;

describe('recovery codes (AT3.4)', () => {
  it('ten different codes in the readable format, each accepted back however it is typed', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
      expect(normaliseRecoveryCode(c)).toBe(c.replace('-', ''));
      expect(normaliseRecoveryCode(` ${c.toLowerCase()} `)).toBe(c.replace('-', ''));
    }
  });

  it('refuses anything that cannot be a code, without throwing', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const n = normaliseRecoveryCode(s);
        return n === null || /^[A-HJKMNP-Z2-9]{10}$/.test(n);
      }),
    );
    expect(normaliseRecoveryCode('ABCDE-FGHJ0')).toBeNull(); // 0 is not in the alphabet
    expect(normaliseRecoveryCode('ABCDE')).toBeNull();
  });

  it('keeps only a fingerprint, the same for the same code and different for different codes', () => {
    expect(hashRecoveryCode('ABCDEFGHJK')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode('ABCDEFGHJK')).toBe(hashRecoveryCode('ABCDEFGHJK'));
    expect(hashRecoveryCode('ABCDEFGHJK')).not.toBe(hashRecoveryCode('ABCDEFGHJM'));
  });
});

describe('who must enter a code (AT3.4; policy D-69)', () => {
  const fresh = [{ method: 'totp', timestamp: NOW - 60 }, { method: 'password', timestamp: NOW - 120 }];

  it('someone who switched it on must use it every sign-in; someone who did not is not asked', () => {
    expect(mfaGate({ aal: 'aal1', amr: [], hasFactor: true, admin: false, nowSeconds: NOW })).toBe('verify');
    expect(mfaGate({ aal: 'aal2', amr: fresh, hasFactor: true, admin: false, nowSeconds: NOW })).toBe('ok');
    expect(mfaGate({ aal: 'aal1', amr: [], hasFactor: false, admin: false, nowSeconds: NOW })).toBe('ok');
  });

  it('the admin must set it up, must use it, and needs a code from the last 12 hours', () => {
    expect(mfaGate({ aal: 'aal1', amr: [], hasFactor: false, admin: true, nowSeconds: NOW })).toBe('enroll');
    expect(mfaGate({ aal: 'aal1', amr: [], hasFactor: true, admin: true, nowSeconds: NOW })).toBe('verify');
    expect(mfaGate({ aal: 'aal2', amr: fresh, hasFactor: true, admin: true, nowSeconds: NOW })).toBe('ok');
    const old = [{ method: 'totp', timestamp: NOW - ADMIN_MFA_FRESH_SECONDS - 1 }];
    expect(mfaGate({ aal: 'aal2', amr: old, hasFactor: true, admin: true, nowSeconds: NOW })).toBe('reverify');
    expect(mfaGate({ aal: 'aal2', amr: 'nonsense', hasFactor: true, admin: true, nowSeconds: NOW })).toBe('reverify');
  });

  it('reads the latest authenticator check from the token, ignoring other methods and junk', () => {
    expect(lastAuthenticatorCheck([{ method: 'totp', timestamp: 5 }, { method: 'totp', timestamp: 9 }, { method: 'password', timestamp: 99 }])).toBe(9);
    expect(lastAuthenticatorCheck([{ method: 'totp', timestamp: '9' }, null, 3])).toBeNull();
    expect(lastAuthenticatorCheck(undefined)).toBeNull();
  });

  it('accepts only six-digit codes and same-site return paths', () => {
    expect(isAuthenticatorCode('123456')).toBe(true);
    expect(isAuthenticatorCode('12345')).toBe(false);
    expect(isAuthenticatorCode('12345a')).toBe(false);
    expect(safeNext('/app/admin')).toBe('/app/admin');
    expect(safeNext('//evil.test')).toBe('/app');
    expect(safeNext('https://evil.test')).toBe('/app');
    expect(safeNext('/\\evil.test')).toBe('/app');
  });
});
