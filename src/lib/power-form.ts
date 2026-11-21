// PowerForms (D-87): public links to a one-person template. No I/O; used by the server actions and the tests.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The code in a public link: 16 random bytes, 22 URL-safe characters. Unguessable; a form is found only by its link. */
export function newFormSlug(): string {
  return randomBytes(16).toString('base64url');
}
export const SLUG = /^[A-Za-z0-9_-]{22}$/;

/** A person needs at least this long between the page loading and sending it; a script posting at once is refused. */
export const MIN_FILL_SECONDS = 3;
/** A form left open longer than this must be reloaded. */
export const MAX_FILL_SECONDS = 2 * 3600;

const mac = (key: string, slug: string, issued: number) => createHmac('sha256', key).update(`easysign.powerform.v1|${slug}|${issued}`).digest('base64url');

/** Put into the page when it loads: when it was loaded, signed, so the time cannot be made up. */
export function formToken(key: string, slug: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  return `${issued}.${mac(key, slug, issued)}`;
}

/** 'ok', or why the submission is refused: no or forged token, sent too fast, or the page is too old. Never throws. */
export function checkFormToken(key: string, slug: string, token: unknown, now = Date.now()): 'ok' | 'invalid' | 'too_fast' | 'expired' {
  if (typeof token !== 'string') return 'invalid';
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return 'invalid';
  const issued = Number(m[1]);
  const expected = Buffer.from(mac(key, slug, issued));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  const age = now / 1000 - issued;
  if (age < MIN_FILL_SECONDS) return 'too_fast';
  if (age > MAX_FILL_SECONDS) return 'expired';
  return 'ok';
}
