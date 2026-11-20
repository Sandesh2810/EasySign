import { describe, expect, it } from 'vitest';
// the backup scripts are plain Node (.mjs); their encryption is tested here
import { decryptFile, deriveKey, encryptFile, keyCheck, keyMatches, newSalt } from '../../scripts/lib/backup-crypto.mjs';

const PASS = 'correct horse battery staple';

describe('backup encryption (AT3.7)', () => {
  it('round-trips a file; the key check recognises the right passphrase and refuses a wrong one', async () => {
    const salt = newSalt();
    const key = await deriveKey(PASS, salt);
    const data = Buffer.from('{"id":1,"note":"ünïcode ✓"}\n');
    const enc = encryptFile(key, 'db/public.envelopes.ndjson', data);
    expect(enc.includes(Buffer.from('note'))).toBe(false);
    expect(decryptFile(key, 'db/public.envelopes.ndjson', enc).equals(data)).toBe(true);
    expect(keyMatches(key, keyCheck(key))).toBe(true);
    const wrong = await deriveKey('wrong horse battery staple', salt);
    expect(keyMatches(wrong, keyCheck(key))).toBe(false);
    expect(() => decryptFile(wrong, 'db/public.envelopes.ndjson', enc)).toThrow(/changed or does not belong/);
  });

  it('detects a changed byte and a file swapped under another name', async () => {
    const key = await deriveKey(PASS, newSalt());
    const enc = encryptFile(key, 'a', Buffer.from('hello'));
    const flipped = Buffer.from(enc);
    flipped[20] ^= 1;
    expect(() => decryptFile(key, 'a', flipped)).toThrow();
    expect(() => decryptFile(key, 'b', enc)).toThrow(/does not belong/);
    expect(() => decryptFile(key, 'a', Buffer.from('not ours'))).toThrow(/not a YouNMeSign backup file/);
  });

  it('refuses a short passphrase; the same passphrase and salt give the same key, a new salt a new one', async () => {
    await expect(deriveKey('short', newSalt())).rejects.toThrow(/at least 12/);
    const salt = newSalt();
    expect((await deriveKey(PASS, salt)).equals(await deriveKey(PASS, salt))).toBe(true);
    expect((await deriveKey(PASS, newSalt())).equals(await deriveKey(PASS, salt))).toBe(false);
  });
});
