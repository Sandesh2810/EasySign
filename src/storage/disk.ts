// Encrypted server-disk storage backend. Server/worker only.
// File format: "ESF1" | keyId length (1 byte) | keyId (ascii) | nonce (12) | ciphertext | GCM tag (16)
// AES-256-GCM with a fresh random nonce per file. The bucket and path are bound in as additional
// authenticated data, so a file moved or copied to another location will not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkPath, StorageError, type Bucket, type StorageAdapter } from './types';

const MAGIC = Buffer.from('ESF1', 'ascii');

export interface DiskStorageOptions {
  root: string;
  /** 32 random bytes, base64url */
  key: string;
  keyId: string;
  /** older keys still accepted for reading, by id (for rotation) */
  previousKeys?: Record<string, string>;
}

const decodeKey = (k: string) => {
  const b = Buffer.from(k, 'base64url');
  if (b.length !== 32) throw new Error('Storage key must be exactly 32 random bytes (base64url)');
  return b;
};

export class DiskStorage implements StorageAdapter {
  readonly backend = 'disk' as const;
  private readonly root: string;
  private readonly keyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(opts: DiskStorageOptions) {
    if (!/^[a-z0-9]{1,16}$/.test(opts.keyId)) throw new Error('Invalid storage key id');
    this.root = path.resolve(opts.root);
    this.keyId = opts.keyId;
    this.keys.set(opts.keyId, decodeKey(opts.key));
    for (const [id, k] of Object.entries(opts.previousKeys ?? {})) this.keys.set(id, decodeKey(k));
  }

  private file(bucket: Bucket, rel: string): string {
    const parts = checkPath(bucket, rel);
    const full = path.join(this.root, bucket, ...parts) + '.esf';
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('BAD_PATH', 'Invalid storage path');
    return full;
  }

  // contentType is part of the adapter interface; the disk backend stores opaque encrypted bytes and does not need it.
  async put(bucket: Bucket, rel: string, data: Uint8Array, _opts?: { contentType: string }): Promise<void> {
    void _opts;
    const file = this.file(bucket, rel);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.keyId)!, nonce);
    cipher.setAAD(Buffer.from(`${bucket}/${rel}`, 'utf8'));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    const id = Buffer.from(this.keyId, 'ascii');
    const out = Buffer.concat([MAGIC, Buffer.from([id.length]), id, nonce, body, cipher.getAuthTag()]);

    await mkdir(path.dirname(file), { recursive: true });
    let handle;
    try {
      handle = await open(file, 'wx'); // exclusive create: never overwrite
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('ALREADY_EXISTS', 'A file already exists at this path');
      throw new StorageError('BACKEND', 'Could not write to storage');
    }
    try {
      await handle.writeFile(out);
      await handle.sync();
    } catch {
      await handle.close().catch(() => {});
      await unlink(file).catch(() => {});
      throw new StorageError('BACKEND', 'Could not write to storage');
    }
    await handle.close();
  }

  async get(bucket: Bucket, rel: string): Promise<Uint8Array> {
    const file = this.file(bucket, rel);
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageError('NOT_FOUND', 'File not found in storage');
      throw new StorageError('BACKEND', 'Could not read from storage');
    }
    try {
      if (raw.length < MAGIC.length + 1 + 12 + 16 || !raw.subarray(0, 4).equals(MAGIC)) throw new Error('header');
      const idLen = raw[4];
      const id = raw.subarray(5, 5 + idLen).toString('ascii');
      const key = this.keys.get(id);
      if (!key) throw new Error('unknown key');
      const nonce = raw.subarray(5 + idLen, 5 + idLen + 12);
      const tag = raw.subarray(raw.length - 16);
      const body = raw.subarray(5 + idLen + 12, raw.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`${bucket}/${rel}`, 'utf8'));
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      throw new StorageError('CORRUPT', 'Stored file failed its integrity check');
    }
  }

  async exists(bucket: Bucket, rel: string): Promise<boolean> {
    try {
      await stat(this.file(bucket, rel));
      return true;
    } catch (e) {
      if (e instanceof StorageError) throw e;
      return false;
    }
  }

  async remove(bucket: Bucket, rel: string, opts: { draftOnly?: boolean } = {}): Promise<void> {
    const file = this.file(bucket, rel);
    if (bucket === 'originals' && !opts.draftOnly) throw new StorageError('IMMUTABLE', 'Original documents cannot be deleted');
    await unlink(file).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new StorageError('BACKEND', 'Could not delete from storage');
    });
  }

  async usageBytes(): Promise<number> {
    const walk = async (dir: string): Promise<number> => {
      let total = 0;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        total += e.isDirectory() ? await walk(full) : (await stat(full)).size;
      }
      return total;
    };
    return walk(this.root);
  }
}
