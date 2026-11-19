// Image uploads (PNG, JPG) become a one-page PDF. Images are re-encoded on the way in:
// that strips metadata, defuses malformed files, caps resolution and keeps storage small.
// Server-only.
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

export type UploadKind = 'pdf' | 'png' | 'jpeg';

/** Identify an upload by its first bytes. File names and browser-supplied types are never trusted. */
export function sniffUpload(bytes: Uint8Array): UploadKind | null {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-')) return 'pdf';
  return null;
}

export type ImageToPdfResult =
  | { ok: true; pdf: Uint8Array; pixelWidth: number; pixelHeight: number; flattened: boolean }
  | { ok: false; code: 'NOT_IMAGE' | 'UNREADABLE_IMAGE' | 'IMAGE_TOO_LARGE'; message: string };

const MAX_INPUT_PIXELS = 50_000_000; // ~50 megapixels; anything bigger is refused before decoding
const MAX_SIDE = 2200; // about 200 dpi on a Letter/A4 page
const PAGE_LONG = 792;
const PAGE_SHORT = 612;

export async function imageToPdf(bytes: Uint8Array): Promise<ImageToPdfResult> {
  const kind = sniffUpload(bytes);
  if (kind !== 'png' && kind !== 'jpeg') return { ok: false, code: 'NOT_IMAGE', message: 'This file is not a PNG or JPG image.' };

  let jpeg: Buffer;
  let width: number;
  let height: number;
  let hadAlpha = false;
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    hadAlpha = Boolean(meta.hasAlpha);
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate() // apply camera orientation, then drop the metadata
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    jpeg = out.data;
    width = out.info.width;
    height = out.info.height;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/pixel limit|too large|exceeds/i.test(msg)) return { ok: false, code: 'IMAGE_TOO_LARGE', message: 'This image has too many pixels. Reduce its dimensions and try again.' };
    return { ok: false, code: 'UNREADABLE_IMAGE', message: 'This image appears to be damaged and could not be read.' };
  }

  // Fit the image to a Letter-sized page in its own orientation, keeping the aspect ratio exactly.
  const landscape = width > height;
  const maxW = landscape ? PAGE_LONG : PAGE_SHORT;
  const maxH = landscape ? PAGE_SHORT : PAGE_LONG;
  const scale = Math.min(maxW / width, maxH / height);
  const pageW = width * scale;
  const pageH = height * scale;

  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpeg);
  doc.addPage([pageW, pageH]).drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
  doc.setProducer('YouNMeSign');
  const pdf = await doc.save({ useObjectStreams: false });
  return { ok: true, pdf, pixelWidth: width, pixelHeight: height, flattened: hadAlpha };
}
