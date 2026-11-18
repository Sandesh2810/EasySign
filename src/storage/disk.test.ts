import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DiskStorage } from './disk';
import { StorageError } from './types';

const ORG = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';
const p = (name: string) => `${ORG}/${ENV}/${name}`;
const key = () => randomBytes(32).toString('base64url');

describe('DiskStorage (AES-256-GCM per file)', () => {
  let dir: string;
  let store: DiskStorage;
  const plain = new TextEncoder().encode('%PDF-1.7 confidential contract body ' + 'x'.repeat(2000));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'easysign-store-'));
    store = new DiskStorage({ root: dir, key: key(), keyId: 'k1' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fileOf = (bucket: string, rel: string) => path.join(dir, bucket, ...rel.split('/')) + '.esf';

  it('round-trips bytes exactly', async () => {
    await store.put('originals', p('a'), plain, { contentType: 'application/pdf' });
    expect(Buffer.from(await store.get('originals', p('a'))).equals(Buffer.from(plain))).toBe(true);
    expect(await store.exists('originals', p('a'))).toBe(true);
    expect(await store.exists('originals', p('missing'))).toBe(false);
  });

  it('what lands on disk is not the plaintext', async () => {
    await store.put('sealed', p('a'), plain, { contentType: 'application/pdf' });
    const onDisk = readFileSync(fileOf('sealed', p('a')));
    expect(onDisk.includes(Buffer.from('confidential contract body'))).toBe(false);
    expect(onDisk.length).toBeGreaterThan(plain.length);
  });

  it('two writes of the same content produce different ciphertext (fresh nonce per file)', async () => {
    await store.put('sealed', p('a'), plain, { contentType: 'application/pdf' });
    await store.put('sealed', p('b'), plain, { contentType: 'application/pdf' });
    expect(readFileSync(fileOf('sealed', p('a'))).equals(readFileSync(fileOf('sealed', p('b'))))).toBe(false);
  });

  it('never overwrites: a second put to the same path is refused and the first content survives', async () => {
    await store.put('originals', p('a'), plain, { contentType: 'application/pdf' });
    await expect(store.put('originals', p('a'), new Uint8Array([1, 2, 3]), { contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(Buffer.from(await store.get('originals', p('a'))).equals(Buffer.from(plain))).toBe(true);
  });

  it('detects a flipped byte', async () => {
    await store.put('sealed', p('a'), plain, { contentType: 'application/pdf' });
    const f = fileOf('sealed', p('a'));
    const bytes = readFileSync(f);
    bytes[bytes.length - 40] ^= 0x01;
    writeFileSync(f, bytes);
    await expect(store.get('sealed', p('a'))).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('a file copied to another path or bucket does not decrypt (bound to its location)', async () => {
    await store.put('sealed', p('a'), plain, { contentType: 'application/pdf' });
    copyFileSync(fileOf('sealed', p('a')), fileOf('sealed', p('b')));
    await expect(store.get('sealed', p('b'))).rejects.toMatchObject({ code: 'CORRUPT' });
    mkdirSync(path.dirname(fileOf('originals', p('a'))), { recursive: true });
    copyFileSync(fileOf('sealed', p('a')), fileOf('originals', p('a')));
    await expect(store.get('originals', p('a'))).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('cannot be read with a different key', async () => {
    await store.put('sealed', p('a'), plain, { contentType: 'application/pdf' });
    const other = new DiskStorage({ root: dir, key: key(), keyId: 'k1' });
    await expect(other.get('sealed', p('a'))).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects path traversal and odd paths before touching the disk', async () => {
    for (const bad of ['../x', `${ORG}/../../etc/passwd`, `/${ORG}/${ENV}/a`, `${ORG}\\${ENV}\\a`, `${ORG}/${ENV}/a b`, `${ORG}/${ENV}/`, '', `${ORG}/${ENV}/a/../b`, `${ORG}/${ENV}/%2e%2e`]) {
      await expect(store.put('sealed', bad, plain, { contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'BAD_PATH' });
      await expect(store.get('sealed', bad)).rejects.toMatchObject({ code: 'BAD_PATH' });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects unknown buckets', async () => {
    // @ts-expect-error deliberate
    await expect(store.put('secrets', p('a'), plain, { contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'BAD_PATH' });
  });

  it('refuses to delete originals; other buckets can be cleaned up', async () => {
    await store.put('originals', p('a'), plain, { contentType: 'application/pdf' });
    await expect(store.remove('originals', p('a'))).rejects.toMatchObject({ code: 'IMMUTABLE' });
    await store.remove('originals', p('a'), { draftOnly: true });
    expect(await store.exists('originals', p('a'))).toBe(false);
    await store.put('signatures', p('s'), plain, { contentType: 'image/png' });
    await store.remove('signatures', p('s'));
    expect(await store.exists('signatures', p('s'))).toBe(false);
  });

  it('reports usage and a missing file clearly', async () => {
    expect(await store.usageBytes()).toBe(0);
    await store.put('sealed', p('a'), plain, { contentType: 'application/pdf' });
    expect(await store.usageBytes()).toBeGreaterThan(plain.length);
    await expect(store.get('sealed', p('nope'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a weak key', () => {
    expect(() => new DiskStorage({ root: dir, key: 'short', keyId: 'k1' })).toThrow();
  });
});
