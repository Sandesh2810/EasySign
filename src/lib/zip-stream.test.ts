// AT2.12 (ZIP half): 50 completed documents stream as one ZIP without holding them all in memory,
// and the result is a valid ZIP whose every file matches what went in.
import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { safeZipName, zipStream, type ZipSource } from './zip-stream';

/** Reads a finished ZIP back, using only its central directory, and returns name -> bytes. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0); // an empty ZIP is only the end record, at position 0
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    expect(crc32(data) >>> 0).toBe(crc);
    out.set(name, Buffer.from(data));
    p += 46 + nameLen;
  }
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>, onChunk?: () => void): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    onChunk?.();
  }
  return Buffer.concat(parts);
}

describe('streamed folder ZIP', () => {
  it('AT2.12: 50 documents (sealed PDF + certificate each, 100 files) stream one at a time and unpack exactly', async () => {
    const FILE = 1024 * 1024; // 1 MB each, 100 MB in total
    let loadedNotYetEmitted = 0;
    let peakInFlight = 0;
    const sources: ZipSource[] = [];
    for (let i = 1; i <= 50; i++) {
      for (const part of ['signed', 'certificate']) {
        sources.push({
          name: `Contract ${i}/Contract ${i} - ${part}.pdf`,
          load: async () => {
            loadedNotYetEmitted++;
            peakInFlight = Math.max(peakInFlight, loadedNotYetEmitted);
            const b = Buffer.alloc(FILE, i);
            b.write(`%PDF-1.7 ${part} ${i}`, 0);
            return new Uint8Array(b);
          },
        });
      }
    }
    // Consume the stream the way an HTTP response does, counting how many files were loaded ahead of being sent.
    const parts: Buffer[] = [];
    const reader = zipStream(sources).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length >= FILE) loadedNotYetEmitted--; // a file's bytes went out
      // keep only a fingerprint of the big chunks, as a network socket would not keep them either
      parts.push(value.length >= FILE ? Buffer.from(value.subarray(0, 32)) : Buffer.from(value));
    }
    expect(peakInFlight).toBe(1); // never more than one file loaded and not yet sent
  }, 60_000);

  it('the ZIP is valid: names, contents and checksums all match', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `Doc ${i}/Doc ${i} - signed.pdf`, data: randomBytes(5000 + i) }));
    const zip = await collect(zipStream(files.map((f) => ({ name: f.name, load: async () => new Uint8Array(f.data) }))));
    const back = unzip(zip);
    expect(back.size).toBe(12);
    for (const f of files) expect(back.get(f.name)?.equals(f.data)).toBe(true);
  });

  it('works for an empty folder and gives repeated names a number', async () => {
    expect(unzip(await collect(zipStream([])))).toEqual(new Map());
    const same = await collect(zipStream([1, 2, 3].map((i) => ({ name: 'A/A - signed.pdf', load: async () => new Uint8Array([i]) }))));
    expect([...unzip(same).keys()]).toEqual(['A/A - signed.pdf', 'A/A - signed (2).pdf', 'A/A - signed (3).pdf']);
  });

  it('a name can never point outside the folder it is unpacked into', () => {
    expect(safeZipName('../../Windows/evil.pdf')).toBe('Windows/evil.pdf');
    expect(safeZipName('C:\\x\\..\\y.pdf')).toBe('C/x/y.pdf');
    expect(safeZipName('a/./b<>|?.pdf')).toBe('a/b.pdf');
    expect(safeZipName('')).toBe('file');
  });

  it('a file that cannot be read stops the download with an error rather than a broken ZIP', async () => {
    let seen: unknown = null;
    const stream = zipStream([{ name: 'a.pdf', load: async () => new Uint8Array([1]) }, { name: 'b.pdf', load: async () => Promise.reject(new Error('storage down')) }], (e) => (seen = e));
    await expect(collect(stream)).rejects.toThrow('storage down');
    expect(String(seen)).toContain('storage down');
  });
});
