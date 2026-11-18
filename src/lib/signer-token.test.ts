import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { newNonce, deriveToken, hashToken, tokensEqual, signSession, verifySession, generateOtp, hashOtp } from './signer-token';

const key = randomBytes(32).toString('base64url');
const tokenId = '7b1e6c1e-1111-4111-8111-aaaaaaaaaaaa';

describe('signer token (D-21)', () => {
  it('is derived, deterministic and URL-safe with 256 bits', () => {
    const nonce = newNonce();
    const a = deriveToken(key, tokenId, nonce);
    expect(a).toBe(deriveToken(key, tokenId, nonce));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('changes with the nonce (re-mint), the token id and the key', () => {
    const nonce = newNonce();
    const a = deriveToken(key, tokenId, nonce);
    expect(deriveToken(key, tokenId, newNonce())).not.toBe(a);
    expect(deriveToken(key, '7b1e6c1e-2222-4222-8222-bbbbbbbbbbbb', nonce)).not.toBe(a);
    expect(deriveToken(randomBytes(32).toString('base64url'), tokenId, nonce)).not.toBe(a);
  });
  it('nonce is 16 random bytes', () => {
    expect(newNonce()).toHaveLength(16);
    expect(newNonce().equals(newNonce())).toBe(false);
  });
  it('refuses a weak key', () => {
    expect(() => deriveToken('short', tokenId, newNonce())).toThrow();
  });
  it('only the SHA-256 of the token is stored, and it never contains the token', () => {
    const t = deriveToken(key, tokenId, newNonce());
    const h = hashToken(t);
    expect(h).toHaveLength(32);
    expect(h.toString('hex')).not.toContain(t);
    expect(hashToken(t).equals(h)).toBe(true);
  });
  it('constant-time comparison works and tolerates different lengths', () => {
    const h = hashToken('abc');
    expect(tokensEqual(h, hashToken('abc'))).toBe(true);
    expect(tokensEqual(h, hashToken('abd'))).toBe(false);
    expect(tokensEqual(h, Buffer.from('short'))).toBe(false);
  });
});

describe('signer session cookie (D-23)', () => {
  const claims = { tokenId, recipientId: 'r-1', envelopeId: 'e-1', level: 'link' as const };
  const now = new Date('2026-11-17T12:00:00Z');

  it('round-trips and is bound to the token id', () => {
    const c = signSession(claims, key, { now, ttlSeconds: 1800 });
    const v = verifySession(c, key, { now: new Date('2026-11-17T12:10:00Z') });
    expect(v).toMatchObject({ ok: true, claims: { tokenId, recipientId: 'r-1', envelopeId: 'e-1', level: 'link' } });
  });
  it('expires', () => {
    const c = signSession(claims, key, { now, ttlSeconds: 1800 });
    expect(verifySession(c, key, { now: new Date('2026-11-17T12:30:01Z') })).toMatchObject({ ok: false, reason: 'expired' });
  });
  it('rejects tampering with the payload or signature, a wrong key, and garbage', () => {
    const c = signSession(claims, key, { now, ttlSeconds: 1800 });
    const [p, s] = c.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), envelopeId: 'e-2' })).toString('base64url');
    expect(verifySession(`${forged}.${s}`, key, { now }).ok).toBe(false);
    const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    expect(verifySession(`${p}.${flipped}`, key, { now }).ok).toBe(false);
    expect(verifySession(c, randomBytes(32).toString('base64url'), { now }).ok).toBe(false);
    for (const junk of ['', 'a', 'a.b', 'a.b.c', '....']) expect(verifySession(junk, key, { now }).ok).toBe(false);
  });
});

describe('OTP', () => {
  it('is 6 digits from a CSPRNG and stored only as a hash bound to the recipient', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const o = generateOtp();
      expect(o).toMatch(/^\d{6}$/);
      seen.add(o);
    }
    expect(seen.size).toBeGreaterThan(400);
    const h = hashOtp('123456', 'recipient-1', key);
    expect(h).toHaveLength(32);
    expect(hashOtp('123456', 'recipient-2', key).equals(h)).toBe(false);
    expect(hashOtp('123457', 'recipient-1', key).equals(h)).toBe(false);
  });
});
