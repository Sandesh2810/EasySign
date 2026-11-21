// D-90: API key format and fingerprints. No I/O.
import { createHash, randomBytes } from 'node:crypto';

export const API_SCOPES = ['documents:read', 'documents:write', 'documents:send'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** A new key: "ynms_" + 43 random URL-safe characters (32 bytes). Only the SHA-256 and the first 12 characters are kept. */
export function newApiKey(): { key: string; prefix: string; sha256: string } {
  const key = `ynms_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), sha256: keySha256(key) };
}

export const keySha256 = (key: string) => createHash('sha256').update(key).digest('hex');

/** The key from an "Authorization: Bearer ynms_…" header, or null. */
export function bearerKey(header: string | null): string | null {
  const m = /^Bearer\s+(ynms_[A-Za-z0-9_-]{43})\s*$/.exec(header ?? '');
  return m ? m[1] : null;
}

/** Seconds until a fixed rate-limit window (aligned to the clock, as the database counts them) starts again. */
export function retryAfterSeconds(windowSeconds: number, nowMs = Date.now()): number {
  const s = nowMs / 1000;
  return Math.max(1, Math.ceil(windowSeconds - (s % windowSeconds)));
}

/** What identifies a write for idempotency: method, path and exact body. */
export const requestSha256 = (method: string, path: string, body: string) => createHash('sha256').update(`${method}\n${path}\n${body}`).digest('hex');
