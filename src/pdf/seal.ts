// Sealing engine (docs/ARCHITECTURE.md section 5, DECISIONS D-22, D-33).
// original bytes (never modified) -> draw field values and stamps -> footer band + QR on every page
// -> append Certificate of Completion -> signature placeholder -> save once (object streams off)
// -> sign (PKCS#7 detached, SHA-256) -> check our own output independently -> hash -> standalone certificate.
// Pure function of its input: no database, no network. Server/worker only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument, rgb, degrees, type PDFFont, type PDFImage, type PDFPage, type Color } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
// named class, not the default export: the default comes through as a wrapper object in the worker's bundle
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SUBFILTER_ADOBE_PKCS7_DETACHED } from '@signpdf/utils';
import { PRODUCT_NAME } from '@/config/brand';
import { displaySize, normaliseBox, rectToPdf, type FracRect, type PageBox, type PdfRect } from '@/lib/geometry';
import type { SealKey } from './seal-key';
import { checkPdfSeal } from './verify-seal';

/** Height of the band added to the displayed bottom of every original page so the footer never covers content. */
export const FOOTER_BAND = 48;

export interface SealRecipient {
  id: string;
  name: string;
  email: string;
  role: 'signer' | 'approver' | 'cc' | 'viewer' | 'in_person';
  order: number;
  authMethod: 'link' | 'access_code' | 'email_otp';
  consentVersion: string | null;
  signatureMethod?: 'drawn' | 'typed' | 'uploaded' | null;
  ip: string | null;
  userAgent: string | null;
  /** approximate country/region, or null when not determined */
  region: string | null;
  timeline: { sent?: Date; viewed?: Date; consented?: Date; completed?: Date; declined?: Date };
  /** D-81: signing group; completedBy is set for a member who was no longer needed because another member signed */
  group?: { label: string; completedBy: string | null };
  /** D-83: earlier holders of this place, oldest first: who handed it over, to whom, when and why */
  handoffs?: { fromName: string; fromEmail: string; toName: string; by: 'sender' | 'signer'; at: Date; reason: string | null }[];
}

export type SealField =
  | { page: number; rect: FracRect; kind: 'signature' | 'initials'; imagePng: Uint8Array; signerName: string; signedAtUtc: Date; signatureId: string }
  | { page: number; rect: FracRect; kind: 'text'; text: string }
  // Phase 4 slice 3 (D-78): a tick box (drawn as a square, with an X when ticked) and a wrapped note
  | { page: number; rect: FracRect; kind: 'check'; checked: boolean }
  | { page: number; rect: FracRect; kind: 'note'; text: string };

export interface SealInput {
  original: Uint8Array;
  envelope: {
    id: string;
    publicCode: string;
    title: string;
    originalSha256: string;
    verifyUrl: string;
    completedAtUtc: Date;
    sender: { name: string; email: string };
    /** how the personal links reached the recipients: emailed by the product, or handed over by the sender */
    delivery?: 'email' | 'link';
  };
  recipients: SealRecipient[];
  fields: SealField[];
  /** audit chain position at sealing_started (D-22) */
  audit: { checkpointSeq: number; checkpointHash: string };
  /** cryptographic seal (Phase 3, AT3.1). Without it the file is sealed visually only (tests of the layout). The worker always passes it. */
  seal?: { key: SealKey; signingTime: Date };
}

export interface SealOutput {
  sealed: Uint8Array;
  /** standalone certificate; unlike the appended one it carries the sealed file's hash */
  certificate: Uint8Array;
  /** with a seal: SHA-256 over the bytes the signature covers (D-22); without one, equal to finalSha256 */
  presealSha256: string;
  finalSha256: string;
  /** SHA-256 of the seal certificate that signed the file, or null when unsigned */
  sealKeyId: string | null;
  pageCount: number;
  certificatePages: number;
  warnings: string[];
}

const INK = rgb(0.102, 0.094, 0.094);
const MUTED = rgb(0.369, 0.353, 0.333);
const HAIRLINE = rgb(0.78, 0.77, 0.74);
const WHITE = rgb(1, 1, 1);

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const fmtUtc = (d: Date) => `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

let fontBytes: { regular: Buffer; bold: Buffer } | null = null;
function loadFontBytes() {
  if (!fontBytes) {
    const dir = path.join(process.cwd(), 'assets', 'fonts');
    fontBytes = { regular: readFileSync(path.join(dir, 'DejaVuSans.ttf')), bold: readFileSync(path.join(dir, 'DejaVuSans-Bold.ttf')) };
  }
  return fontBytes;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  safe: (s: string) => string;
}

async function embedFonts(doc: PDFDocument, warnings: Set<string>): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const b = loadFontBytes();
  const regular = await doc.embedFont(b.regular, { subset: true });
  const bold = await doc.embedFont(b.bold, { subset: true });
  const charset = new Set(regular.getCharacterSet());
  const boldSet = new Set(bold.getCharacterSet());
  const safe = (s: string) => {
    let out = '';
    for (const ch of String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ')) {
      const cp = ch.codePointAt(0)!;
      if (charset.has(cp) && boldSet.has(cp)) out += ch;
      else {
        out += '?';
        warnings.add('Some characters could not be drawn in the bundled font and were replaced with "?".');
      }
    }
    return out;
  };
  return { regular, bold, safe };
}

/** Drawing in the field's own upright coordinate system: origin = its displayed bottom-left, x right, y up. */
function frame(page: PDFPage, r: PdfRect) {
  const t = (r.rotateCcwDegrees * Math.PI) / 180;
  const cos = Math.round(Math.cos(t));
  const sin = Math.round(Math.sin(t));
  const pt = (lx: number, ly: number) => ({ x: r.anchor.x + cos * lx - sin * ly, y: r.anchor.y + sin * lx + cos * ly });
  const rotate = degrees(r.rotateCcwDegrees);
  return {
    w: r.drawWidth,
    h: r.drawHeight,
    text(str: string, lx: number, ly: number, size: number, font: PDFFont, color: Color = INK) {
      page.drawText(str, { ...pt(lx, ly), size, font, color, rotate });
    },
    image(img: PDFImage, lx: number, ly: number, width: number, height: number) {
      page.drawImage(img, { ...pt(lx, ly), width, height, rotate });
    },
    rect(lx: number, ly: number, width: number, height: number, color: Color) {
      page.drawRectangle({ ...pt(lx, ly), width, height, color, rotate, borderWidth: 0 });
    },
    line(x1: number, y1: number, x2: number, y2: number, thickness: number, color: Color = INK) {
      page.drawLine({ start: pt(x1, y1), end: pt(x2, y2), thickness, color });
    },
  };
}

function pageBox(p: PDFPage): PageBox {
  const m = p.getMediaBox();
  const c = p.getCropBox();
  return normaliseBox([m.x, m.y, m.x + m.width, m.y + m.height], [c.x, c.y, c.x + c.width, c.y + c.height], p.getRotation().angle);
}

/** Grow the visible box by the footer band on whichever unrotated edge is the displayed bottom. */
function extendBox(b: PageBox): PageBox {
  switch (b.rotate) {
    case 0:
      return { ...b, y: b.y - FOOTER_BAND, height: b.height + FOOTER_BAND };
    case 90:
      return { ...b, width: b.width + FOOTER_BAND };
    case 180:
      return { ...b, height: b.height + FOOTER_BAND };
    case 270:
      return { ...b, x: b.x - FOOTER_BAND, width: b.width + FOOTER_BAND };
  }
}

function applyBox(p: PDFPage, ext: PageBox) {
  const m = p.getMediaBox();
  const x1 = Math.min(m.x, ext.x);
  const y1 = Math.min(m.y, ext.y);
  const x2 = Math.max(m.x + m.width, ext.x + ext.width);
  const y2 = Math.max(m.y + m.height, ext.y + ext.height);
  p.setMediaBox(x1, y1, x2 - x1, y2 - y1);
  p.setCropBox(ext.x, ext.y, ext.width, ext.height);
}

function fitSize(font: PDFFont, lines: string[], maxWidth: number, start: number, min: number): number | null {
  for (let size = start; size >= min - 1e-9; size -= 0.25) {
    if (Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size))) <= maxWidth) return size;
  }
  return null;
}

function drawSignature(page: PDFPage, box: PageBox, f: Extract<SealField, { kind: 'signature' | 'initials' }>, fonts: Fonts, img: PDFImage) {
  const fr = frame(page, rectToPdf(box, f.rect));
  const a = fonts.safe(`Signed by: ${f.signerName}`);
  const b = fmtUtc(f.signedAtUtc);
  const c = fonts.safe(`ID: ${f.signatureId}`);
  const layouts = [[`${a} · ${b} · ${c}`], [`${a} ·`, `${b} · ${c}`], [`${a} ·`, `${b} ·`, c]];
  const LEAD = 1.25;
  // Pick the layout that gives the largest type (up to 6 pt); fewer lines win a tie.
  let lines = layouts[2];
  let size = 0;
  for (const candidate of layouts) {
    const maxByHeight = (fr.h * 0.55) / (candidate.length * LEAD);
    const s = fitSize(fonts.regular, candidate, fr.w, Math.min(6, maxByHeight), 4);
    if (s && s > size + 1e-9) {
      lines = candidate;
      size = s;
    }
  }
  if (!size) {
    // very small field: shrink until the three-line form fits, but stay legible when zoomed
    const widest = Math.max(...lines.map((l) => fonts.regular.widthOfTextAtSize(l, 1)));
    size = Math.max(2.5, Math.min(fr.w / widest, (fr.h * 0.6) / (lines.length * LEAD)));
  }
  const textHeight = lines.length * size * LEAD;
  const imgArea = Math.max(fr.h - textHeight - 1, fr.h * 0.3);
  const scale = Math.min(fr.w / img.width, imgArea / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  fr.image(img, 0, fr.h - imgArea + (imgArea - ih) / 2, iw, ih);
  lines.forEach((line, i) => fr.text(line, 0, textHeight - (i + 1) * size * LEAD + size * 0.3, size, fonts.regular, INK));
}

function drawTextField(page: PDFPage, box: PageBox, f: Extract<SealField, { kind: 'text' }>, fonts: Fonts) {
  const fr = frame(page, rectToPdf(box, f.rect));
  let str = fonts.safe(f.text).trim();
  if (!str) return;
  let size = fitSize(fonts.regular, [str], fr.w - 2, Math.min(11, fr.h * 0.7), 4);
  if (size === null) {
    // Too long for the field even at the smallest size: cut it so it can never run over the
    // document's own text. The full value stays in the database and its hash in the audit trail.
    size = 4;
    while (str.length > 1 && fonts.regular.widthOfTextAtSize(`${str}…`, size) > fr.w - 2) str = str.slice(0, -1);
    str = `${str}…`;
  }
  fr.text(str, 1, Math.max(0, (fr.h - size) / 2) + size * 0.2, size, fonts.regular, INK);
}

/** A square in the middle of the field; an X across it when ticked. */
function drawCheck(page: PDFPage, box: PageBox, f: Extract<SealField, { kind: 'check' }>) {
  const fr = frame(page, rectToPdf(box, f.rect));
  const s = Math.max(4, Math.min(fr.w, fr.h) - 1);
  const x = (fr.w - s) / 2;
  const y = (fr.h - s) / 2;
  const t = Math.max(0.5, s * 0.06);
  fr.line(x, y, x + s, y, t);
  fr.line(x + s, y, x + s, y + s, t);
  fr.line(x + s, y + s, x, y + s, t);
  fr.line(x, y + s, x, y, t);
  if (f.checked) {
    const m = s * 0.2;
    fr.line(x + m, y + m, x + s - m, y + s - m, t * 2);
    fr.line(x + m, y + s - m, x + s - m, y + m, t * 2);
  }
}

/** Word-wrapped text that stays inside the field: the largest size (10 pt down to 4 pt) at which it fits, else cut with "…". */
function drawNote(page: PDFPage, box: PageBox, f: Extract<SealField, { kind: 'note' }>, fonts: Fonts) {
  const fr = frame(page, rectToPdf(box, f.rect));
  const words = fonts.safe(f.text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return;
  const LEAD = 1.2;
  const wrap = (size: number) => {
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (fonts.regular.widthOfTextAtSize(next, size) <= fr.w - 2 || !cur) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  let size = Math.min(10, Math.max(4, fr.h * 0.6));
  let lines = wrap(size);
  while (size > 4 && lines.length * size * LEAD > fr.h) {
    size = Math.max(4, size - 0.5);
    lines = wrap(size);
  }
  const fit = Math.max(1, Math.floor(fr.h / (size * LEAD)));
  if (lines.length > fit) {
    lines = lines.slice(0, fit);
    let last = lines[fit - 1];
    while (last.length > 1 && fonts.regular.widthOfTextAtSize(`${last}…`, size) > fr.w - 2) last = last.slice(0, -1);
    lines[fit - 1] = `${last}…`;
  }
  lines.forEach((line, i) => {
    // a single word wider than the field is cut too, so nothing ever runs over the document's own text
    let l = line;
    while (l.length > 1 && fonts.regular.widthOfTextAtSize(l, size) > fr.w - 2) l = l.slice(0, -1);
    fr.text(l, 1, fr.h - (i + 1) * size * LEAD + size * 0.2, size, fonts.regular, INK);
  });
}

interface Qr {
  size: number;
  dark: (row: number, col: number) => boolean;
}
function qrFor(text: string): Qr {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = q.modules;
  return { size, dark: (r, c) => data[r * size + c] === 1 };
}

const FOOTER_MARGIN = 28;
const QR_SIZE = 34; // leaves a quiet zone of about four modules inside the band

function drawFooter(page: PDFPage, box: PageBox, fonts: Fonts, text: string, qr: Qr) {
  const disp = displaySize(box);
  const hFrac = FOOTER_BAND / disp.height;
  const fr = frame(page, rectToPdf(box, { x: 0, y: 1 - hFrac, w: 1, h: hFrac }));
  fr.rect(0, 0, fr.w, FOOTER_BAND, WHITE); // hide anything that was outside the old visible area
  fr.rect(FOOTER_MARGIN, FOOTER_BAND - 1, fr.w - 2 * FOOTER_MARGIN, 0.5, HAIRLINE);

  const qx = fr.w - FOOTER_MARGIN - QR_SIZE;
  const qy = (FOOTER_BAND - QR_SIZE) / 2 - 0.5;
  const m = QR_SIZE / qr.size;
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.dark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < qr.size && qr.dark(r, c + run)) run++;
      fr.rect(qx + c * m, qy + (qr.size - 1 - r) * m, run * m, m, INK);
      c += run;
    }
  }

  const avail = qx - FOOTER_MARGIN - 10;
  const one = fitSize(fonts.regular, [text], avail, 7, 5);
  if (one) {
    fr.text(text, FOOTER_MARGIN, FOOTER_BAND / 2 - one * 0.35, one, fonts.regular, MUTED);
  } else {
    const cut = text.indexOf(' · Verify:');
    const lines = cut > 0 ? [text.slice(0, cut + 2), text.slice(cut + 3)] : [text];
    const size = fitSize(fonts.regular, lines, avail, 7, 3) ?? 3;
    lines.forEach((l, i) => fr.text(l, FOOTER_MARGIN, FOOTER_BAND / 2 + (lines.length / 2 - i - 1) * size * 1.3 + size * 0.15, size, fonts.regular, MUTED));
  }
}

// ---------- Certificate of Completion ----------
const LETTER: PageBox = { x: 0, y: 0, width: 612, height: 792, rotate: 0 };
const LEFT = 54;
const VALUE_X = 196;
const RIGHT = 612 - 54;
const BOTTOM = FOOTER_BAND + 24;

const AUTH_LABEL = { link: 'Link only', access_code: 'Access code', email_otp: 'Email one-time code' } as const;
const METHOD_LABEL = { drawn: 'Drawn', typed: 'Typed', uploaded: 'Uploaded image' } as const;
const ROLE_LABEL = { signer: 'Signer', approver: 'Approver', cc: 'Receives a copy', viewer: 'Needs to view', in_person: 'In-person signer' } as const;

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && font.widthOfTextAtSize(line.slice(0, n), size) > width) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line);
  }
  return out;
}

function writeCertificate(doc: PDFDocument, fonts: Fonts, input: SealInput, originalPages: number, hashes: { preseal: string; final: string } | null): PDFPage[] {
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([LETTER.width, LETTER.height]);
    pages.push(page);
    y = LETTER.height - 60;
  };
  const need = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };
  const line = (str: string, x: number, size: number, font: PDFFont, color: Color = INK) => page.drawText(str, { x, y: y - size, size, font, color });
  const kv = (label: string, value: string) => {
    const lines = wrap(fonts.regular, fonts.safe(value), 8.5, RIGHT - VALUE_X);
    need(lines.length * 12.5 + 3);
    line(fonts.safe(label), LEFT, 7.5, fonts.bold, MUTED);
    for (const l of lines) {
      line(l, VALUE_X, 8.5, fonts.regular);
      y -= 12.5;
    }
    y -= 3;
  };
  const kvLines = (label: string, values: string[]) => {
    need(values.length * 12.5 + 3);
    line(fonts.safe(label), LEFT, 7.5, fonts.bold, MUTED);
    for (const v of values) {
      for (const l of wrap(fonts.regular, fonts.safe(v), 8.5, RIGHT - VALUE_X)) {
        line(l, VALUE_X, 8.5, fonts.regular);
        y -= 12.5;
      }
    }
    y -= 3;
  };
  const heading = (str: string) => {
    need(40);
    y -= 10;
    line(fonts.safe(str), LEFT, 11, fonts.bold);
    y -= 17;
    page.drawRectangle({ x: LEFT, y, width: RIGHT - LEFT, height: 0.5, color: HAIRLINE, borderWidth: 0 });
    y -= 10;
  };
  const para = (str: string, size = 8.5, color: Color = INK) => {
    for (const l of wrap(fonts.regular, fonts.safe(str), size, RIGHT - LEFT)) {
      need(size * 1.5);
      line(l, LEFT, size, fonts.regular, color);
      y -= size * 1.5;
    }
  };

  const e = input.envelope;
  newPage();
  line(PRODUCT_NAME, LEFT, 9, fonts.bold, MUTED);
  y -= 18;
  line('Certificate of Completion', LEFT, 20, fonts.bold);
  y -= 30;
  line(fonts.safe(`Verification code ${e.publicCode}`), LEFT, 10, fonts.regular, MUTED);
  y -= 20;

  heading('Document');
  kv('Title', e.title);
  kv('Envelope ID', e.id);
  kv('Verification code', e.publicCode);
  kv('Verify at', e.verifyUrl);
  kv('Pages in original', String(originalPages));
  kv('Original SHA-256', e.originalSha256);
  kvLines('Audit checkpoint', [`event ${input.audit.checkpointSeq} at sealing`, input.audit.checkpointHash]);
  kv('Completed', fmtUtc(e.completedAtUtc));
  kv('Sender', `${e.sender.name} <${e.sender.email}>`);
  kv('Links delivered', e.delivery === 'link' ? `Shared by the sender (not emailed by ${PRODUCT_NAME})` : e.delivery === 'email' ? `Emailed by ${PRODUCT_NAME} to each address below` : 'Not recorded');
  if (hashes) {
    kv('Sealed file SHA-256', hashes.final);
    kv('Pre-seal SHA-256', hashes.preseal);
  } else {
    y -= 2;
    para('The SHA-256 of the sealed file is shown on the standalone certificate and at the verify address. A file cannot contain its own hash.', 7.5, MUTED);
  }
  kvLines('Digital seal', input.seal ? [`Signed with the ${PRODUCT_NAME} seal certificate (self-signed)`, `key id ${input.seal.key.certSha256}`] : ['None']);

  heading('Recipients');
  const sorted = [...input.recipients].sort((p, q) => p.order - q.order);
  sorted.forEach((r, i) => {
    need(200); // keep a recipient's block together on one page
    line(fonts.safe(`${i + 1}. ${r.name} <${r.email}>`), LEFT, 9.5, fonts.bold);
    y -= 16;
    kv('Role', `${ROLE_LABEL[r.role]} · order ${r.order}`);
    if (r.group) kv('Signing group', fonts.safe(r.group.completedBy ? `${r.group.label} · not needed: ${r.group.completedBy} signed for the group` : r.group.label));
    if (r.handoffs?.length) {
      kvLines(
        'Handed over',
        r.handoffs.map((h) =>
          fonts.safe(`${h.fromName} <${h.fromEmail}> to ${h.toName}, ${h.by === 'signer' ? `by ${h.fromName}` : 'by the sender'}, ${fmtUtc(h.at)}${h.reason ? `: ${h.reason}` : ''}`),
        ),
      );
    }
    kv('Authentication', AUTH_LABEL[r.authMethod]);
    kv('Consent to e-records', r.consentVersion ? `${r.consentVersion}${r.timeline.consented ? ` · ${fmtUtc(r.timeline.consented)}` : ''}` : 'Not applicable');
    kv('Signature method', r.signatureMethod ? METHOD_LABEL[r.signatureMethod] : 'Not applicable');
    kv('IP address (at consent)', r.ip ?? 'Not recorded');
    kv('Device (at consent)', r.userAgent ? r.userAgent.slice(0, 160) : 'Not recorded');
    kv('Approximate location', r.region ?? 'Not determined');
    const t = r.timeline;
    const steps = [
      t.sent && `Sent ${fmtUtc(t.sent)}`,
      t.viewed && `Viewed ${fmtUtc(t.viewed)}`,
      t.consented && `Consented ${fmtUtc(t.consented)}`,
      t.completed && `${r.role === 'approver' ? 'Approved' : 'Signed'} ${fmtUtc(t.completed)}`,
      t.declined && `Declined ${fmtUtc(t.declined)}`,
    ].filter((s): s is string => Boolean(s));
    kvLines('Timeline', steps.length ? steps : ['No activity recorded']);
    y -= 6;
  });

  heading('About this certificate');
  para(
    `This certificate is an electronic audit trail generated by ${PRODUCT_NAME}. It records the actions taken through the personal link issued for each recipient above. ` +
      `Where links were shared by the sender, ${PRODUCT_NAME} did not itself deliver them to the addresses shown. ` +
      'It is not proof of physical presence, and it is not proof of identity beyond possession of that link (and control of the email address, where the link was emailed) and any access code used. ' +
      'All times are Coordinated Universal Time (UTC). The audit checkpoint is the position and hash of the envelope\'s audit chain when sealing began; ' +
      'an audit export is consistent with this certificate when its event at that position has the same hash.' +
      (input.seal
        ? ` The sealed document carries a digital seal: a PDF reader such as Adobe Acrobat Reader reports whether the file was changed after sealing. The seal certificate is self-signed, so a reader cannot confirm on its own who ${PRODUCT_NAME} is; enter the verification code at the verify address to check the document with ${PRODUCT_NAME}.`
        : ''),
  );
  return pages;
}

const footerText = (code: string, n: number, total: number, verifyUrl: string) =>
  `${PRODUCT_NAME} · Envelope ${code} · Page ${n} of ${total} · Verify: ${verifyUrl.replace(/^https?:\/\//, '')}`;

export async function buildSealedPdf(input: SealInput): Promise<SealOutput> {
  if (sha256(input.original) !== input.envelope.originalSha256.toLowerCase()) {
    throw new Error('The original document does not match its recorded hash; refusing to seal.');
  }
  const warnings = new Set<string>();
  const doc = await PDFDocument.load(input.original, { updateMetadata: false });
  const fonts = await embedFonts(doc, warnings);
  const pages = doc.getPages();
  const boxes = pages.map(pageBox);

  // validate everything before drawing anything
  for (const f of input.fields) {
    if (!Number.isInteger(f.page) || f.page < 1 || f.page > pages.length) throw new Error(`A field refers to page ${f.page}, which does not exist.`);
    rectToPdf(boxes[f.page - 1], f.rect); // throws "outside the page" for bad geometry
  }

  const images = new Map<Uint8Array, PDFImage>();
  for (const f of input.fields) {
    const page = pages[f.page - 1];
    const box = boxes[f.page - 1];
    if (f.kind === 'text') {
      drawTextField(page, box, f, fonts);
    } else if (f.kind === 'check') {
      drawCheck(page, box, f);
    } else if (f.kind === 'note') {
      drawNote(page, box, f, fonts);
    } else {
      let img = images.get(f.imagePng);
      if (!img) {
        img = await doc.embedPng(f.imagePng);
        images.set(f.imagePng, img);
      }
      drawSignature(page, box, f, fonts, img);
    }
  }

  const extended = boxes.map(extendBox);
  pages.forEach((p, i) => applyBox(p, extended[i]));

  const certPages = writeCertificate(doc, fonts, input, pages.length, null);
  const total = pages.length + certPages.length;
  const qr = qrFor(input.envelope.verifyUrl);
  const { publicCode, verifyUrl } = input.envelope;
  pages.forEach((p, i) => drawFooter(p, extended[i], fonts, footerText(publicCode, i + 1, total, verifyUrl), qr));
  certPages.forEach((p, i) => drawFooter(p, LETTER, fonts, footerText(publicCode, pages.length + i + 1, total, verifyUrl), qr));

  doc.setProducer(PRODUCT_NAME);
  doc.setModificationDate(input.envelope.completedAtUtc);
  if (input.seal) {
    pdflibAddPlaceholder({
      pdfDoc: doc,
      reason: `Sealed by ${PRODUCT_NAME} after every party completed`,
      contactInfo: '',
      name: PRODUCT_NAME,
      location: '',
      signingTime: input.seal.signingTime,
      subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
      appName: PRODUCT_NAME,
    });
  }
  const saved = await doc.save({ useObjectStreams: false });
  let sealed: Uint8Array = saved;
  let presealSha256: string;
  let sealKeyId: string | null = null;
  if (input.seal) {
    const { key, signingTime } = input.seal;
    sealed = await new SignPdf().sign(Buffer.from(saved), new P12Signer(key.p12, { passphrase: key.passphrase }), signingTime);
    // check our own output independently before anyone sees it: a broken seal is worse than none
    const check = checkPdfSeal(sealed);
    if (!check.intact || check.signerCertSha256 !== key.certSha256 || !check.computedDigest) {
      throw new Error(`The sealed file failed its own signature check: ${check.problem ?? 'wrong signing certificate'}`);
    }
    presealSha256 = check.computedDigest;
    sealKeyId = key.certSha256;
  } else {
    presealSha256 = sha256(sealed); // no cryptographic signature: the two hashes are the same (D-22)
  }
  const finalSha256 = sha256(sealed);

  const cdoc = await PDFDocument.create();
  const cfonts = await embedFonts(cdoc, warnings);
  const standalone = writeCertificate(cdoc, cfonts, input, pages.length, { preseal: presealSha256, final: finalSha256 });
  standalone.forEach((p, i) => drawFooter(p, LETTER, cfonts, footerText(publicCode, i + 1, standalone.length, verifyUrl), qr));
  cdoc.setTitle(`Certificate of Completion ${publicCode}`);
  cdoc.setProducer(PRODUCT_NAME);
  cdoc.setCreationDate(input.envelope.completedAtUtc);
  cdoc.setModificationDate(input.envelope.completedAtUtc);
  const certificate = await cdoc.save({ useObjectStreams: false });

  return { sealed, certificate, presealSha256, finalSha256, sealKeyId, pageCount: total, certificatePages: certPages.length, warnings: [...warnings] };
}
