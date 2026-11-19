// Access codes (brief: "sender-defined, hashed with Argon2id or scrypt"; DECISIONS D-59).
// The sender invents a code and gives it to the signer personally. EasySign stores only a slow,
// salted scrypt hash, so the code cannot be read back by anyone, including the sender.
// Server-only: uses node:crypto. No extra package is needed.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Cost settings stored inside each hash, so they can be raised later without breaking old codes. */
const PARAMS = { N: 32768, r: 8, p: 3 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** scrypt needs about 128 * N * r bytes; allow twice that so the call never fails on the memory check. */
const maxmemFor = (N: number, r: number) => 256 * N * r;

export const ACCESS_CODE_MIN = 6;
export const ACCESS_CODE_MAX = 64;

export type CodeCheck = { ok: true; value: string } | { ok: false; message: string };

/** What counts as an acceptable code. Spaces at the ends are dropped; everything else is kept as typed. */
export function checkAccessCode(raw: unknown): CodeCheck {
  if (typeof raw !== 'string') return { ok: false, message: 'Type an access code.' };
  const value = raw.trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: 'An access code cannot contain line breaks or control characters.' };
  if (value.length < ACCESS_CODE_MIN) return { ok: false, message: `An access code needs at least ${ACCESS_CODE_MIN} characters.` };
  if (value.length > ACCESS_CODE_MAX) return { ok: false, message: `An access code can be up to ${ACCESS_CODE_MAX} characters.` };
  if (new Set(value).size < 3) return { ok: false, message: 'Use an access code that is harder to guess (not the same character repeated).' };
  return { ok: true, value };
}

function derive(code: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(code.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns "scrypt$N$r$p$salt$hash" (salt and hash in base64url). */
export async function hashAccessCode(code: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(code, salt, PARAMS.N, PARAMS.r, PARAMS.p, KEY_LENGTH);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** True only when the code produces the stored hash. A malformed stored value is simply "no match". */
export async function verifyAccessCode(code: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof code !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // refuse settings nobody here would have written, so a planted value cannot be used to exhaust memory
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 1024 || N > 131072 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 8) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 16 || expected.length < 32 || expected.length > 64) return false;
  try {
    const actual = await derive(code.trim(), salt, N, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** "r•••@example.test": enough for the person to recognise their own address, not enough to reveal it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return 'your email address';
  return `${email[0]}•••${email.slice(at)}`;
}
