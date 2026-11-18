// Test-only helpers: build PDFs with awkward geometry and hostile content, and read sealed output back.
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, concatTransformationMatrix } from 'pdf-lib';
import { deflateSync, crc32 } from 'node:zlib';

export interface FixtureOptions {
  /** leave the page-4 content stream with a scaled, shifted coordinate system and no restore */
  dirtyGraphicsState?: boolean;
}

/** Five pages: portrait, landscape, rotated 90, cropped (+ optional dirty graphics state), odd size rotated 270. */
export async function makeContractFixture(opts: FixtureOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const p1 = doc.addPage([612, 792]);
  p1.drawText('Page one body text: consulting agreement.', { x: 72, y: 700, size: 12, font });

  const p2 = doc.addPage([792, 612]);
  p2.drawText('Page two landscape schedule.', { x: 72, y: 540, size: 12, font });

  const p3 = doc.addPage([612, 792]);
  p3.setRotation(degrees(90));
  p3.drawText('Page three rotated ninety.', { x: 72, y: 700, size: 12, font });

  const p4 = doc.addPage([612, 792]);
  p4.setCropBox(50, 60, 512, 672);
  p4.drawText('Page four cropped.', { x: 100, y: 600, size: 12, font });
  if (opts.dirtyGraphicsState) p4.pushOperators(concatTransformationMatrix(2, 0, 0, 2, 100, 100));

  const p5 = doc.addPage([500, 700]);
  p5.setRotation(degrees(270));
  p5.drawText('Page five odd size rotated two seventy.', { x: 60, y: 620, size: 12, font });

  return doc.save();
}

export async function makeBlankPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

export async function makeHostilePdf(kind: 'javascript' | 'launch' | 'embedded' | 'form' | 'signed' | 'encrypted' | 'open-uri' | 'open-goto' | 'link'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const addAnnot = (dict: Record<string, unknown>) => {
    const ref = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], ...dict }));
    page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  };
  switch (kind) {
    case 'javascript':
      doc.addJavaScript('boot', 'app.alert("hi");');
      break;
    case 'launch':
      addAnnot({ A: { S: 'Launch', F: PDFString.of('cmd.exe') } });
      break;
    case 'embedded':
      await doc.attach(new Uint8Array([1, 2, 3]), 'payload.bin', { mimeType: 'application/octet-stream' });
      break;
    case 'form':
      doc.getForm().createTextField('name').addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
      break;
    case 'signed':
      ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 10, 20, 30] }));
      break;
    case 'encrypted':
      ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFString.of('o'.repeat(32)), U: PDFString.of('u'.repeat(32)), P: -4 }));
      break;
    case 'open-uri':
      doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'URI', URI: PDFString.of('https://example.test/phish') }));
      break;
    case 'open-goto':
      doc.catalog.set(PDFName.of('OpenAction'), ctx.obj([page.ref, PDFName.of('Fit')]));
      break;
    case 'link':
      addAnnot({ A: { S: 'URI', URI: PDFString.of('https://example.test/terms') } });
      break;
  }
  return doc.save();
}

/** Minimal valid RGBA PNG: a dark diagonal stroke on transparent, enough to stand in for a signature. */
export function makeSignaturePng(width = 120, height = 40): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const on = Math.abs(x - Math.round((y / height) * width)) < 3 || y === height - 6;
      const o = row + 1 + x * 4;
      raw[o] = 20;
      raw[o + 1] = 20;
      raw[o + 2] = 60;
      raw[o + 3] = on ? 255 : 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

export interface ExtractedText {
  /** all text on the page joined with spaces */
  text: string;
  /** every text run with its origin in unrotated PDF user space */
  items: { str: string; x: number; y: number }[];
}

/** Read text back out of a PDF with pdf.js, the same engine the browser viewer uses. */
export async function extractText(bytes: Uint8Array): Promise<ExtractedText[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const out: ExtractedText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter((it): it is typeof it & { str: string; transform: number[] } => 'str' in it).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
    out.push({ text: items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(), items });
  }
  await task.destroy();
  return out;
}
