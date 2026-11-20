// Two-step sign-in (MFA) rules (Phase 3 slice 4, AT3.4, D-69). Pure: no I/O.
// Policy decided by Sandesh 2026-11-19: required for the platform admin, optional for everyone else.
// Anyone who has switched it on must use it every time they sign in. Admin pages also need a recent code.
import { createHash, randomInt } from 'node:crypto';

/** How recent the admin's last authenticator code must be to use the admin pages. */
export const ADMIN_MFA_FRESH_SECONDS = 12 * 3600;
export const RECOVERY_CODE_COUNT = 10;

// No 0/O, 1/I/L: easy to read aloud and to type from paper.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10; // 31^10 ≈ 2^49.5

/** Ten fresh recovery codes, shown once, as "ABCDE-FGHJK". */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT, pick: (max: number) => number = randomInt): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[pick(ALPHABET.length)];
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/** What the person typed, reduced to the 10 code characters; null if it cannot be a recovery code. */
export function normaliseRecoveryCode(input: string): string | null {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

/** What the database keeps: never the code itself. */
export const hashRecoveryCode = (normalised: string) => createHash('sha256').update(`younmesign-recovery|${normalised}`, 'utf8').digest('hex');

export const isAuthenticatorCode = (s: string) => /^\d{6}$/.test(String(s ?? '').trim());

/** Seconds since 1970 of the most recent authenticator-app check in the session token's "amr" claim. */
export function lastAuthenticatorCheck(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const e of amr) {
    if (e && typeof e === 'object' && (e as { method?: unknown }).method === 'totp') {
      const t = (e as { timestamp?: unknown }).timestamp;
      if (typeof t === 'number' && Number.isFinite(t) && (latest === null || t > latest)) latest = t;
    }
  }
  return latest;
}

export type MfaGate = 'ok' | 'verify' | 'enroll' | 'reverify';

/**
 * What this session must do before going on.
 * verify: has an authenticator but this session has not used it. enroll: the admin has none yet.
 * reverify: the admin's last code is older than the admin limit.
 */
export function mfaGate(v: { aal: unknown; amr: unknown; hasFactor: boolean; admin: boolean; nowSeconds: number }): MfaGate {
  if (v.hasFactor && v.aal !== 'aal2') return 'verify';
  if (!v.admin) return 'ok';
  if (!v.hasFactor) return 'enroll';
  const last = lastAuthenticatorCheck(v.amr);
  if (last === null || v.nowSeconds - last > ADMIN_MFA_FRESH_SECONDS) return 'reverify';
  return 'ok';
}

/** Deleting a document or changing the retention period needs an authenticator code from the last 10 minutes (D-71). */
export const DANGEROUS_ACTION_FRESH_SECONDS = 10 * 60;

/** True when this session used its authenticator within `seconds`. */
export function usedAuthenticatorWithin(v: { aal: unknown; amr: unknown; nowSeconds: number; seconds: number }): boolean {
  if (v.aal !== 'aal2') return false;
  const last = lastAuthenticatorCheck(v.amr);
  return last !== null && v.nowSeconds - last <= v.seconds && last <= v.nowSeconds + 60;
}

/** Only same-site paths, as for sign-in (the code page sends people back to where they were going). */
export function safeNext(next: unknown, fallback = '/app'): string {
  const s = typeof next === 'string' ? next : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
