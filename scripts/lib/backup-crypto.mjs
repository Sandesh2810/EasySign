// Backup encryption (Phase 3 slice 8, AT3.7, D-73). AES-256-GCM with a key derived from Sandesh's passphrase by
// scrypt. Each file: magic "YNMSBK01" (8) | nonce (12) | ciphertext | tag (16); the file's own name inside the backup
// is bound in as associated data, so files cannot be swapped or renamed without detection. A key check value in
// backup.json lets a restore say "wrong passphrase" before touching anything. Losing the passphrase loses the backup.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const MAGIC = Buffer.from('YNMSBK01', 'ascii');
export const KDF = { name: 'scrypt', N: 2 ** 16, r: 8, p: 1, keyLength: 32 };
export const MIN_PASSPHRASE = 12;

export async function deriveKey(passphrase, saltHex, kdf = KDF) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  return new Promise((resolve, reject) =>
    scrypt(passphrase.normalize('NFC'), Buffer.from(saltHex, 'hex'), kdf.keyLength, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

export const newSalt = () => randomBytes(16).toString('hex');
export const keyCheck = (key) => createHmac('sha256', key).update('younmesign-backup-key-check-v1').digest('hex');

export function keyMatches(key, check) {
  const a = Buffer.from(keyCheck(key), 'hex');
  const b = Buffer.from(String(check ?? ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encryptFile(key, name, plaintext) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(name, 'utf8'));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([MAGIC, nonce, body, c.getAuthTag()]);
}

/** Throws if the file was changed, renamed, or the key is wrong. */
export function decryptFile(key, name, data) {
  const buf = Buffer.from(data);
  if (buf.length < MAGIC.length + 12 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${name}: not a YouNMeSign backup file`);
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(name, 'utf8'));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(buf.subarray(MAGIC.length + 12, buf.length - 16)), d.final()]);
  } catch {
    throw new Error(`${name}: the file was changed or does not belong here`);
  }
}

/** File name on disk for a logical name: no folders, nothing a Windows path would choke on. */
export function diskName(index) {
  return `${String(index).padStart(6, '0')}.bin`;
}
