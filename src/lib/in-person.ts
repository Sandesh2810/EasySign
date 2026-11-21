// In-person signing (D-86): the host's PIN and the screen's timing. No I/O; used by the server actions and the tests.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** The screen locks after this long without a touch, click or key press (WCAG 2.2.1: a warning comes first). */
export const IDLE_LOCK_SECONDS = 180;
/** The warning shows this long before the lock; any touch or key press dismisses it. */
export const IDLE_WARNING_SECONDS = 30;
/** While someone is using the screen, the server is told this often (it locks a session after 5 quiet minutes itself). */
export const HEARTBEAT_SECONDS = 60;

const PIN = /^[0-9]{4,8}$/;

/** Why a PIN chosen by the host is not acceptable, or null when it is. */
export function pinProblem(pin: string, confirm?: string): string | null {
  if (!PIN.test(pin)) return 'Choose a PIN of 4 to 8 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'Choose a PIN that is not one digit repeated.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Choose a PIN that is not a run of digits such as 1234.';
  if (confirm !== undefined && confirm !== pin) return 'The two PINs are not the same.';
  return null;
}

// scrypt with a fresh salt per session; stored as "scrypt$<salt hex>$<hash hex>"
const N = 16384;
const KEYLEN = 32;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, { N, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** True only for the PIN the hash was made from. Never throws; a malformed stored value matches nothing. */
export function verifyPin(pin: string, stored: string): boolean {
  if (typeof pin !== 'string' || !PIN.test(pin)) return false;
  const m = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(stored ?? '');
  if (!m) return false;
  const expected = Buffer.from(m[2], 'hex');
  const actual = scryptSync(pin, Buffer.from(m[1], 'hex'), KEYLEN, { N, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}
