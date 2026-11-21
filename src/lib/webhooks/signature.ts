// D-92: webhook signatures in the Standard Webhooks format (symmetric "v1"): HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<raw body>" with the secret's bytes, base64, sent as "v1,<signature>". Several
// signatures are separated by spaces (during a secret change both the new and the old secret sign).
// [VERIFIED: github.com/standard-webhooks/standard-webhooks spec/standard-webhooks.md, via Context7, 2026-11-21]
// Pure: node:crypto only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { REPLAY_WINDOW_SECONDS } from './events';

const PREFIX = 'whsec_';

/** A new signing secret: "whsec_" + 32 random bytes in base64 (the standard allows 24 to 64 bytes). */
export function newWebhookSecret(): string {
  return PREFIX + randomBytes(32).toString('base64');
}

/** The HMAC key inside a secret; throws on anything that is not a well-formed secret. */
export function secretBytes(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) throw new Error('not a webhook secret');
  const b64 = secret.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('not a webhook secret');
  const key = Buffer.from(b64, 'base64');
  if (key.length < 24 || key.length > 64) throw new Error('not a webhook secret');
  return key;
}

/** The id and timestamp must not contain "." (they are the separators); ids here are UUIDs. */
function signedContent(id: string, timestamp: number, body: string): Buffer {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('bad webhook id');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('bad webhook timestamp');
  return Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), Buffer.from(body, 'utf8')]);
}

export function signature(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', secretBytes(secret)).update(signedContent(id, timestamp, body)).digest('base64')}`;
}

/** The webhook-signature header: one "v1,…" per secret, space separated. */
export function signatureHeader(secrets: string[], id: string, timestamp: number, body: string): string {
  if (secrets.length === 0) throw new Error('no secret');
  return secrets.map((s) => signature(s, id, timestamp, body)).join(' ');
}

/**
 * What a receiver does (also used by the tests): the timestamp is within the replay window and one of the "v1"
 * signatures matches, compared in constant time.
 */
export function verifyWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = REPLAY_WINDOW_SECONDS,
): boolean {
  const { id, timestamp, signature: header } = headers;
  if (!id || !timestamp || !header || !/^\d{1,12}$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signature(secret, id, ts, body).slice(3), 'base64');
  } catch {
    return false;
  }
  return header.split(' ').some((part) => {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
