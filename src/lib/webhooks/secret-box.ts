// D-92: a webhook secret has to be readable again to sign each delivery, so it cannot be stored as a hash. It is
// stored encrypted: AES-256-GCM with a key derived (HKDF-SHA256) from STORAGE_KEY for this one purpose, and the
// endpoint's id bound in as associated data, so a stored secret cannot be moved to another endpoint. Pure: the key is
// passed in.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function boxKey(storageKey: string): Buffer {
  const raw = Buffer.from(storageKey, 'base64url');
  if (raw.length !== 32) throw new Error('Storage key must be exactly 32 random bytes (base64url)');
  return Buffer.from(hkdfSync('sha256', raw, Buffer.from('younmesign-webhooks'), Buffer.from('webhook secret box v1'), 32));
}

export function sealSecret(secret: string, endpointId: string, storageKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', boxKey(storageKey), nonce);
  cipher.setAAD(Buffer.from(endpointId, 'utf8'));
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64url')}`;
}

export function openSecret(boxed: string, endpointId: string, storageKey: string): string {
  const [version, body] = boxed.split('.', 2);
  if (version !== VERSION || !body) throw new Error('unknown secret format');
  const b = Buffer.from(body, 'base64url');
  if (b.length < 12 + 16 + 1) throw new Error('secret too short');
  const decipher = createDecipheriv('aes-256-gcm', boxKey(storageKey), b.subarray(0, 12));
  decipher.setAAD(Buffer.from(endpointId, 'utf8'));
  decipher.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([decipher.update(b.subarray(12, b.length - 16)), decipher.final()]).toString('utf8');
}
