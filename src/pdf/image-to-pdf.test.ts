import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { imageToPdf, sniffUpload } from './image-to-pdf';
import { inspectPdf } from './inspect';

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer();
const jpg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();

describe('sniffUpload: decides by content, not by file name', () => {
  it('recognises PDF, PNG and JPEG and nothing else', async () => {
    expect(sniffUpload(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('pdf');
    expect(sniffUpload(await png(10, 10))).toBe('png');
    expect(sniffUpload(await jpg(10, 10))).toBe('jpeg');
    expect(sniffUpload(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF
    expect(sniffUpload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffUpload(new Uint8Array([0x4d, 0x5a]))).toBeNull(); // Windows executable
    expect(sniffUpload(new Uint8Array(0))).toBeNull();
  });
});

describe('imageToPdf', () => {
  it('turns a PNG into a one-page PDF that passes the normal upload gate', async () => {
    const r = await imageToPdf(await png(1200, 800));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const info = await inspectPdf(r.pdf);
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.pageCount).toBe(1);
      // landscape image -> landscape page, same aspect ratio
      expect(info.pages[0].width / info.pages[0].height).toBeCloseTo(1200 / 800, 2);
      expect(info.pages[0].width).toBeLessThanOrEqual(792);
    }
  });

  it('turns a JPEG into a PDF and keeps portrait orientation', async () => {
    const r = await imageToPdf(await jpg(600, 900));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = await PDFDocument.load(r.pdf);
    const { width, height } = doc.getPage(0).getSize();
    expect(height).toBeGreaterThan(width);
    expect(width / height).toBeCloseTo(600 / 900, 2);
  });

  it('compresses large photos on ingest (longest side capped, output far smaller than raw pixels)', async () => {
    const big = await sharp({ create: { width: 5000, height: 3500, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 95 }).toBuffer();
    const r = await imageToPdf(big);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pixelWidth).toBeLessThanOrEqual(2200);
    expect(r.pdf.length).toBeLessThan(big.length);
  });

  it('flattens transparency onto white so signatures and stamps stay readable', async () => {
    const r = await imageToPdf(await png(400, 300));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flattened).toBe(true);
  });

  it('rejects things that are not PNG or JPEG, and broken images, without throwing', async () => {
    for (const bad of [new TextEncoder().encode('hello'), new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]), (await png(50, 50)).subarray(0, 40)]) {
      const r = await imageToPdf(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(['NOT_IMAGE', 'UNREADABLE_IMAGE']).toContain(r.code);
    }
  });

  it('rejects a decompression bomb (tiny file, enormous pixel count)', async () => {
    const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(2_000_000);
    const r = await imageToPdf(bomb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('IMAGE_TOO_LARGE');
  });
});
