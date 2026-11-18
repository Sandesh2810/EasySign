// Public verification code: ES-YYMM-XXXX-XXXX-XXXX-CC  (DECISIONS D-32)
// 12 payload symbols = 60 random bits from the OS CSPRNG; CC = 10-bit check over prefix + month + payload.
// Alphabet: Crockford base32 (no I, L, O, U).
import { createHash, randomBytes } from 'node:crypto';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'ES';
const PAYLOAD_SYMBOLS = 12;
const CHECK_SYMBOLS = 2;

export type RandomSource = (bytes: number) => Buffer;

function encode(value: bigint, symbols: number): string {
  let out = '';
  for (let i = symbols - 1; i >= 0; i--) out += ALPHABET[Number((value >> BigInt(i * 5)) & 31n)];
  return out;
}

function check(yymm: string, payload: string): string {
  const digest = createHash('sha256').update(`${PREFIX}${yymm}${payload}`, 'utf8').digest();
  const tenBits = (digest[0] << 2) | (digest[1] >> 6);
  return encode(BigInt(tenBits), CHECK_SYMBOLS);
}

function format(yymm: string, payload: string, cc: string): string {
  return `${PREFIX}-${yymm}-${payload.slice(0, 4)}-${payload.slice(4, 8)}-${payload.slice(8, 12)}-${cc}`;
}

export function generatePublicCode(date: Date = new Date(), random: RandomSource = randomBytes): string {
  const yymm = String(date.getUTCFullYear() % 100).padStart(2, '0') + String(date.getUTCMonth() + 1).padStart(2, '0');
  const bytes = random(8);
  if (bytes.length !== 8) throw new Error('Random source must return 8 bytes');
  const sixtyBits = bytes.readBigUInt64BE(0) >> 4n;
  const payload = encode(sixtyBits, PAYLOAD_SYMBOLS);
  return format(yymm, payload, check(yymm, payload));
}

/** Tidy what a person typed. Returns the canonical form, or null if it cannot be a code. Does not verify the check. */
export function normalisePublicCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (rest.length !== 4 + PAYLOAD_SYMBOLS + CHECK_SYMBOLS) return null;
  const yymm = rest.slice(0, 4);
  if (!/^\d{4}$/.test(yymm)) return null;
  const month = Number(yymm.slice(2));
  if (month < 1 || month > 12) return null;
  const body = rest.slice(4);
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return format(yymm, body.slice(0, PAYLOAD_SYMBOLS), body.slice(PAYLOAD_SYMBOLS));
}

/** True only for a well-formed code whose check symbols match. Safe to call before any database lookup. */
export function isValidPublicCode(input: string): boolean {
  const code = normalisePublicCode(input);
  if (!code) return false;
  const compact = code.replace(/-/g, '');
  const yymm = compact.slice(2, 6);
  const payload = compact.slice(6, 6 + PAYLOAD_SYMBOLS);
  return check(yymm, payload) === compact.slice(6 + PAYLOAD_SYMBOLS);
}

/** Identifier printed beside each signature or initial: running count of stamps in the envelope. */
export function signatureId(publicCode: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('Signature number must be a positive integer');
  return `${publicCode}-S${n}`;
}
