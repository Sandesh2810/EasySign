// Signer link tokens, signer session cookies and OTP hashing (DECISIONS D-21, D-23).
// Server-only: never import from a client component.
// - The token is derived, never stored: HMAC-SHA256(SIGNER_TOKEN_KEY, label | token id | nonce).
// - The database keeps the token id, the nonce and SHA-256(token).
// - After the link is exchanged, the browser holds a short-lived signed cookie bound to the token id.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

function keyBytes(key: string): Buffer {
  const b = Buffer.from(key, 'base64url');
  if (b.length < 32) throw new Error('Key must be at least 32 random bytes (base64url)');
  return b;
}

export const newNonce = (): Buffer => randomBytes(16);

export function deriveToken(key: string, tokenId: string, nonce: Buffer): string {
  return createHmac('sha256', keyBytes(key)).update('easysign.signer.v1|').update(tokenId).update('|').update(nonce).digest('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time equality that does not leak through length differences. */
export function tokensEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export type SessionLevel = 'link' | 'verified';

export interface SessionClaims {
  tokenId: string;
  recipientId: string;
  envelopeId: string;
  /** 'link' = holds the link only; 'verified' = also passed the access code or OTP gate. */
  level: SessionLevel;
}

const sessionMac = (payload: string, key: string) => createHmac('sha256', keyBytes(key)).update('easysign.session.v1|').update(payload).digest();

export function signSession(claims: SessionClaims, key: string, opts: { now?: Date; ttlSeconds: number }): string {
  const exp = Math.floor((opts.now ?? new Date()).getTime() / 1000) + opts.ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp }), 'utf8').toString('base64url');
  return `${payload}.${sessionMac(payload, key).toString('base64url')}`;
}

export type SessionCheck = { ok: true; claims: SessionClaims & { exp: number } } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifySession(cookie: string, key: string, opts: { now?: Date } = {}): SessionCheck {
  const parts = typeof cookie === 'string' ? cookie.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payload, sig] = parts;
  if (!tokensEqual(Buffer.from(sig, 'base64url'), sessionMac(payload, key))) return { ok: false, reason: 'bad_signature' };
  let claims: SessionClaims & { exp: number };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims?.exp !== 'number' || !claims.tokenId || !claims.recipientId || !claims.envelopeId) return { ok: false, reason: 'malformed' };
  if (Math.floor((opts.now ?? new Date()).getTime() / 1000) >= claims.exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

export const generateOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** OTPs are stored only as a keyed hash bound to the recipient. */
export function hashOtp(otp: string, recipientId: string, key: string): Buffer {
  return createHmac('sha256', keyBytes(key)).update('easysign.otp.v1|').update(recipientId).update('|').update(otp).digest();
}
