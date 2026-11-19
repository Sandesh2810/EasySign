// A small streaming ZIP writer (stored entries, no compression: PDFs are already compressed).
// Files are fetched and written one at a time, so memory use stays at about one file, however many files
// the folder holds (AT2.12). No extra package. CRC-32 comes from Node's built-in zlib.
// Limits: no ZIP64, so at most 65,535 files and 4 GB in total; the caller checks before starting.
import { crc32 } from 'node:zlib';

export interface ZipSource {
  /** path inside the ZIP, e.g. "Lease 2027/Lease 2027 - signed.pdf" */
  name: string;
  /** called only when this file's turn comes */
  load: () => Promise<Uint8Array>;
  date?: Date;
}

export const ZIP_MAX_FILES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff;

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Names are kept readable but stripped of anything that could escape the folder when unpacked. */
export function safeZipName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '').trim().slice(0, 120))
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/') || 'file';
}

interface Written {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Returns a web stream that produces the ZIP, pulling one source at a time. */
export function zipStream(sources: Iterable<ZipSource> | AsyncIterable<ZipSource>, onError?: (e: unknown) => void): ReadableStream<Uint8Array> {
  const written: Written[] = [];
  const used = new Set<string>();
  let offset = 0;
  let finished = false;
  const iterator = (Symbol.asyncIterator in Object(sources) ? (sources as AsyncIterable<ZipSource>)[Symbol.asyncIterator]() : (sources as Iterable<ZipSource>)[Symbol.iterator]()) as
    | AsyncIterator<ZipSource>
    | Iterator<ZipSource>;

  const uniqueName = (raw: string) => {
    let name = safeZipName(raw);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let i = 2;
      while (used.has(`${stem} (${i})${ext}`.toLowerCase())) i++;
      name = `${stem} (${i})${ext}`;
    }
    used.add(name.toLowerCase());
    return name;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) return;
        const next = await iterator.next();
        if (!next.done) {
          const src = next.value;
          const data = await src.load();
          if (written.length >= ZIP_MAX_FILES || offset + data.length + 4096 > ZIP_MAX_BYTES) throw new Error('This folder is too large to download as one ZIP file.');
          const name = Buffer.from(uniqueName(src.name), 'utf8');
          const { time, date } = dosTime(src.date ?? new Date());
          const crc = crc32(data) >>> 0;
          const header = Buffer.alloc(30);
          header.writeUInt32LE(0x04034b50, 0);
          header.writeUInt16LE(20, 4); // version needed
          header.writeUInt16LE(0x0800, 6); // UTF-8 names
          header.writeUInt16LE(0, 8); // stored
          header.writeUInt16LE(time, 10);
          header.writeUInt16LE(date, 12);
          header.writeUInt32LE(crc, 14);
          header.writeUInt32LE(data.length, 18);
          header.writeUInt32LE(data.length, 22);
          header.writeUInt16LE(name.length, 26);
          header.writeUInt16LE(0, 28);
          controller.enqueue(new Uint8Array(header));
          controller.enqueue(new Uint8Array(name));
          controller.enqueue(data);
          written.push({ name, crc, size: data.length, offset, time, date });
          offset += header.length + name.length + data.length;
          return;
        }
        // central directory, then the end record
        const start = offset;
        for (const w of written) {
          const c = Buffer.alloc(46);
          c.writeUInt32LE(0x02014b50, 0);
          c.writeUInt16LE(20, 4); // made by
          c.writeUInt16LE(20, 6); // needed
          c.writeUInt16LE(0x0800, 8);
          c.writeUInt16LE(0, 10);
          c.writeUInt16LE(w.time, 12);
          c.writeUInt16LE(w.date, 14);
          c.writeUInt32LE(w.crc, 16);
          c.writeUInt32LE(w.size, 20);
          c.writeUInt32LE(w.size, 24);
          c.writeUInt16LE(w.name.length, 28);
          c.writeUInt32LE(w.offset, 42);
          controller.enqueue(new Uint8Array(c));
          controller.enqueue(new Uint8Array(w.name));
          offset += c.length + w.name.length;
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(written.length, 8);
        end.writeUInt16LE(written.length, 10);
        end.writeUInt32LE(offset - start, 12);
        end.writeUInt32LE(start, 16);
        controller.enqueue(new Uint8Array(end));
        finished = true;
        controller.close();
      } catch (e) {
        onError?.(e);
        controller.error(e);
      }
    },
  },
  // Nothing is fetched ahead: the next file is loaded only when the previous one has been read out.
  { highWaterMark: 0 },
  );
}
