import { describe, it, expect } from 'vitest';
import { checkAccessCode, hashAccessCode, maskEmail, verifyAccessCode } from './access-code';

// The hash shape the database insists on (migration 15, recipients_access_code_hash_shape).
const DB_SHAPE = /^scrypt\$[0-9]{4,7}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]{22,44}\$[A-Za-z0-9_-]{43,86}$/;

describe('access codes', () => {
  it('stores a salted hash of the shape the database accepts, never the code', async () => {
    const h1 = await hashAccessCode('blue-heron-42');
    const h2 = await hashAccessCode('blue-heron-42');
    expect(h1).toMatch(DB_SHAPE);
    expect(h1.length).toBeLessThanOrEqual(200);
    expect(h1).not.toContain('blue-heron-42');
    expect(h1).not.toBe(h2); // a fresh salt every time
    expect(h1.startsWith('scrypt$32768$8$3$')).toBe(true);
  }, 20_000);

  it('accepts the right code and nothing else', async () => {
    const h = await hashAccessCode('blue-heron-42');
    expect(await verifyAccessCode('blue-heron-42', h)).toBe(true);
    expect(await verifyAccessCode('  blue-heron-42  ', h)).toBe(true); // spaces at the ends are not part of a code
    expect(await verifyAccessCode('Blue-heron-42', h)).toBe(false); // capitals matter
    expect(await verifyAccessCode('blue-heron-43', h)).toBe(false);
    expect(await verifyAccessCode('', h)).toBe(false);
  }, 30_000);

  it('a missing, damaged or planted stored value never matches and never throws', async () => {
    const h = await hashAccessCode('blue-heron-42');
    const [, N, r, p, salt, key] = h.split('$');
    for (const stored of [
      null,
      undefined,
      '',
      'blue-heron-42',
      `bcrypt$${N}$${r}$${p}$${salt}$${key}`,
      `scrypt$${N}$${r}$${p}$${salt}`,
      `scrypt$1073741824$${r}$${p}$${salt}$${key}`, // absurd memory cost
      `scrypt$${N}$${r}$99$${salt}$${key}`,
      `scrypt$3000$${r}$${p}$${salt}$${key}`, // not a power of two
      `scrypt$${N}$${r}$${p}$AA$${key}`,
      `scrypt$${N}$${r}$${p}$${salt}$AAAA`,
    ]) {
      expect(await verifyAccessCode('blue-heron-42', stored as string)).toBe(false);
    }
  }, 30_000);

  it('says plainly why a code is not acceptable', () => {
    expect(checkAccessCode('  tulip-7781 ')).toEqual({ ok: true, value: 'tulip-7781' });
    expect(checkAccessCode('12345')).toMatchObject({ ok: false, message: expect.stringContaining('at least 6') });
    expect(checkAccessCode('x'.repeat(65))).toMatchObject({ ok: false, message: expect.stringContaining('up to 64') });
    expect(checkAccessCode('aaaaaaaa')).toMatchObject({ ok: false, message: expect.stringContaining('harder to guess') });
    expect(checkAccessCode('abc\ndef')).toMatchObject({ ok: false });
    expect(checkAccessCode(undefined)).toMatchObject({ ok: false });
    expect(checkAccessCode(123456)).toMatchObject({ ok: false });
  });

  it('shows only enough of an email address to recognise it', () => {
    expect(maskEmail('rita.reyes@example.test')).toBe('r•••@example.test');
    expect(maskEmail('not-an-address')).toBe('your email address');
  });
});
