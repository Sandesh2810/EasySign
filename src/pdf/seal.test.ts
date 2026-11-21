import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { buildSealedPdf, FOOTER_BAND, type SealInput, type SealOutput } from './seal';
import { inspectPdf } from './inspect';
import { makeContractFixture, makeSignaturePng, extractText, type ExtractedText } from './test-fixtures';
import { rectToPdf, type PageBox, type FracRect } from '@/lib/geometry';

const CODE = 'ES-2611-QR2S-WZPC-4YEW-H9';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const signedAt = new Date('2026-11-17T10:00:00Z');

const RECTS: Record<number, FracRect> = {
  1: { x: 0.1, y: 0.8, w: 0.35, h: 0.08 },
  3: { x: 0.55, y: 0.7, w: 0.3, h: 0.1 },
  4: { x: 0.2, y: 0.5, w: 0.4, h: 0.08 },
  5: { x: 0.05, y: 0.1, w: 0.3, h: 0.12 },
};

async function input(original: Uint8Array): Promise<SealInput> {
  const png = makeSignaturePng();
  return {
    original,
    envelope: {
      id: '11111111-1111-4111-8111-111111111111',
      publicCode: CODE,
      title: 'Consulting Agreement — Acme & Zoë Müller',
      originalSha256: sha(original),
      verifyUrl: `https://sign.example.test/verify?code=${CODE}`,
      completedAtUtc: new Date('2026-11-17T10:05:00Z'),
      sender: { name: 'Sandra Sender', email: 'sender@example.test' },
    },
    recipients: [
      {
        // D-86: Alice signed in person on the sender's device
        id: 'r1', name: 'Alice Example', email: 'alice@example.test', role: 'in_person', order: 1, authMethod: 'link', inPerson: { hostName: 'Sandra Sender', hostEmail: 'sender@example.test' },
        consentVersion: 'esign-consent-v1', signatureMethod: 'drawn', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone) Safari', region: 'US-TX (approximate)',
        timeline: { sent: new Date('2026-11-17T09:00:00Z'), viewed: new Date('2026-11-17T09:55:00Z'), consented: new Date('2026-11-17T09:56:00Z'), completed: signedAt },
      },
      {
        id: 'r2', name: 'Zoë Müller-Łukasz', email: 'zoe@example.test', role: 'signer', order: 2, authMethod: 'access_code',
        consentVersion: 'esign-consent-v1', signatureMethod: 'typed', ip: '2001:db8::1', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome', region: null,
        timeline: { sent: new Date('2026-11-17T10:00:30Z'), viewed: new Date('2026-11-17T10:02:00Z'), consented: new Date('2026-11-17T10:02:30Z'), completed: new Date('2026-11-17T10:04:00Z') },
        // D-83: Zoë took over from Ben, who handed his part to her; D-81: a signing group label
        handoffs: [{ fromName: 'Ben Before', fromEmail: 'ben@example.test', toName: 'Zoë Müller-Łukasz', by: 'signer', at: new Date('2026-11-17T10:01:00Z'), reason: 'On leave' }],
        group: { label: 'Board', completedBy: null },
      },
    ],
    fields: [
      { page: 1, rect: RECTS[1], kind: 'signature', imagePng: png, signerName: 'Alice Example', signedAtUtc: signedAt, signatureId: `${CODE}-S1` },
      { page: 1, rect: { x: 0.6, y: 0.8, w: 0.25, h: 0.03 }, kind: 'text', text: '17 Nov 2026' },
      { page: 1, rect: { x: 0.6, y: 0.85, w: 0.3, h: 0.03 }, kind: 'text', text: 'Director, संदेश Labs' },
      { page: 3, rect: RECTS[3], kind: 'signature', imagePng: png, signerName: 'Alice Example', signedAtUtc: signedAt, signatureId: `${CODE}-S2` },
      { page: 4, rect: RECTS[4], kind: 'initials', imagePng: png, signerName: 'Zoë Müller-Łukasz', signedAtUtc: new Date('2026-11-17T10:04:00Z'), signatureId: `${CODE}-S3` },
      { page: 5, rect: RECTS[5], kind: 'signature', imagePng: png, signerName: 'Zoë Müller-Łukasz', signedAtUtc: new Date('2026-11-17T10:04:00Z'), signatureId: `${CODE}-S4` },
    ],
    audit: { checkpointSeq: 23, checkpointHash: 'ab'.repeat(32) },
  };
}

describe('buildSealedPdf', () => {
  let original: Uint8Array;
  let originalHash: string;
  let boxes: PageBox[];
  let out: SealOutput;
  let pages: ExtractedText[];

  beforeAll(async () => {
    original = await makeContractFixture({ dirtyGraphicsState: true });
    originalHash = sha(original);
    const info = await inspectPdf(original);
    if (!info.ok) throw new Error('fixture rejected: ' + info.message);
    boxes = info.pages;
    out = await buildSealedPdf(await input(original));
    pages = await extractText(out.sealed);
  });

  it('leaves the original bytes untouched', () => {
    expect(sha(original)).toBe(originalHash);
  });

  it('keeps every original page and appends the certificate', () => {
    expect(out.pageCount).toBe(5 + out.certificatePages);
    expect(out.certificatePages).toBeGreaterThanOrEqual(1);
    expect(pages).toHaveLength(out.pageCount);
  });

  it('AT1.7: original text is still real, selectable text', () => {
    expect(pages[0].text).toContain('Page one body text: consulting agreement.');
    expect(pages[1].text).toContain('Page two landscape schedule.');
    expect(pages[2].text).toContain('Page three rotated ninety.');
    expect(pages[3].text).toContain('Page four cropped.');
    expect(pages[4].text).toContain('Page five odd size rotated two seventy.');
  });

  it('AT1.7: every page, certificate included, carries the footer with code, page n of N and the verify address', () => {
    pages.forEach((p, i) => {
      expect(p.text).toContain(`YouNMeSign · Envelope ${CODE} · Page ${i + 1} of ${out.pageCount}`);
      expect(p.text).toContain(`Verify: sign.example.test/verify?code=${CODE}`);
    });
  });

  it('AT1.7: each signature carries signer name, UTC date/time and its signature id', () => {
    expect(pages[0].text).toContain(`Signed by: Alice Example · 2026-11-17 10:00:00 UTC · ID: ${CODE}-S1`);
    expect(pages[2].text).toContain(`ID: ${CODE}-S2`);
    expect(pages[3].text).toContain(`Signed by: Zoë Müller-Łukasz · 2026-11-17 10:04:00 UTC · ID: ${CODE}-S3`);
    expect(pages[4].text).toContain(`ID: ${CODE}-S4`);
  });

  it('stamps land inside their field on every geometry: plain, rotated 90, cropped with a dirty graphics state, rotated 270', () => {
    for (const pageNo of [1, 3, 4, 5]) {
      const b = rectToPdf(boxes[pageNo - 1], RECTS[pageNo]).bounds;
      const stamp = pages[pageNo - 1].items.find((i) => i.str.includes('Signed by'));
      expect(stamp, `stamp text on page ${pageNo}`).toBeDefined();
      const pad = 2;
      expect(stamp!.x).toBeGreaterThanOrEqual(b.x - pad);
      expect(stamp!.x).toBeLessThanOrEqual(b.x + b.width + pad);
      expect(stamp!.y).toBeGreaterThanOrEqual(b.y - pad);
      expect(stamp!.y).toBeLessThanOrEqual(b.y + b.height + pad);
    }
  });

  it('typed field values are drawn as text', () => {
    expect(pages[0].text).toContain('17 Nov 2026');
  });

  it('characters the bundled font cannot draw become "?" and are reported, never a crash', () => {
    expect(pages[0].text).toContain('Director, ????? Labs');
    expect(out.warnings.join(' ')).toMatch(/could not be drawn/i);
  });

  it('the footer never overlaps content: each page grows by a band on its displayed bottom edge', async () => {
    const doc = await PDFDocument.load(out.sealed);
    const after = (await inspectPdf(out.sealed, { allowSealed: true }));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const p = after.pages;
    // rotate 0: extends downward
    expect(p[0]).toMatchObject({ x: 0, y: -FOOTER_BAND, width: 612, height: 792 + FOOTER_BAND });
    // landscape, rotate 0
    expect(p[1]).toMatchObject({ y: -FOOTER_BAND, height: 612 + FOOTER_BAND });
    // rotate 90: displayed bottom is the right-hand edge in unrotated space
    expect(p[2]).toMatchObject({ x: 0, y: 0, width: 612 + FOOTER_BAND, height: 792, rotate: 90 });
    // cropped page: the crop box grows, not just the media box
    expect(p[3]).toMatchObject({ x: 50, y: 60 - FOOTER_BAND, width: 512, height: 672 + FOOTER_BAND });
    // rotate 270: displayed bottom is the left-hand edge
    expect(p[4]).toMatchObject({ x: -FOOTER_BAND, y: 0, width: 500 + FOOTER_BAND, height: 700, rotate: 270 });
    expect(doc.getPageCount()).toBe(out.pageCount);
  });

  it('the appended certificate records the evidence and says what it is not', () => {
    const cert = pages.slice(5).map((p) => p.text).join(' ');
    for (const needle of [
      'Certificate of Completion', CODE, 'Consulting Agreement — Acme & Zoë Müller', '11111111-1111-4111-8111-111111111111',
      originalHash, 'ab'.repeat(32), 'event 23', 'Sandra Sender', 'sender@example.test',
      'Alice Example', 'alice@example.test', 'Zoë Müller-Łukasz', 'zoe@example.test', '203.0.113.7', '2001:db8::1',
      'esign-consent-v1', 'Link only', 'Access code', 'Drawn', 'Typed', '2026-11-17 09:56:00 UTC', 'US-TX (approximate)', 'Not determined',
      'not proof of physical presence',
      'In-person signer', 'Signed in person', 'hosted by Sandra Sender <sender@example.test>', 'Handed over', 'Ben Before <ben@example.test>', 'by Ben Before', '2026-11-17 10:01:00 UTC', 'On leave', 'Signing group', 'Board',
    ]) {
      expect(cert, `certificate should contain "${needle}"`).toContain(needle);
    }
  });

  it('D-22: the appended certificate cannot and does not contain the sealed file\'s own hash; the standalone certificate does', async () => {
    expect(out.finalSha256).toBe(sha(out.sealed));
    expect(out.presealSha256).toBe(out.finalSha256); // Phase 1: no cryptographic signature yet
    const appended = pages.slice(5).map((p) => p.text).join(' ');
    expect(appended).not.toContain(out.finalSha256);
    const standalone = (await extractText(out.certificate)).map((p) => p.text).join(' ');
    expect(standalone).toContain(out.finalSha256);
    expect(standalone).toContain(originalHash);
    expect(standalone).toContain('Certificate of Completion');
  });

  it('is saved without object streams and reloads cleanly', async () => {
    expect(Buffer.from(out.sealed).toString('latin1')).not.toContain('/ObjStm');
    const doc = await PDFDocument.load(out.sealed);
    expect(doc.getPageCount()).toBe(out.pageCount);
  });

  it('refuses fields that point at a page that does not exist or lie outside the page', async () => {
    const base = await input(original);
    await expect(buildSealedPdf({ ...base, fields: [{ ...base.fields[0], page: 9 }] })).rejects.toThrow(/page/i);
    await expect(buildSealedPdf({ ...base, fields: [{ ...base.fields[0], rect: { x: 0.9, y: 0.9, w: 0.3, h: 0.3 } }] })).rejects.toThrow(/outside/i);
  });

  // Not an assertion: set EASYSIGN_SAMPLE_DIR to write the files for a human (or a PDF viewer) to look at.
  it.runIf(Boolean(process.env.EASYSIGN_SAMPLE_DIR))('writes sample output for visual inspection', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = process.env.EASYSIGN_SAMPLE_DIR!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sample-original.pdf'), original);
    writeFileSync(join(dir, 'sample-sealed.pdf'), out.sealed);
    writeFileSync(join(dir, 'sample-certificate.pdf'), out.certificate);
  });

  it('refuses to seal if the original does not match its recorded hash', async () => {
    const base = await input(original);
    await expect(buildSealedPdf({ ...base, envelope: { ...base.envelope, originalSha256: 'cd'.repeat(32) } })).rejects.toThrow(/hash/i);
  });
});

// Phase 4 slice 3 (D-78): tick boxes and notes, on an upright and on rotated pages
describe('buildSealedPdf: checkbox and note fields', () => {
  const NOTE = 'Payment is due within thirty days of the invoice date. Late payments carry interest at the statutory rate, compounded monthly until paid in full.';
  let original: Uint8Array;
  beforeAll(async () => {
    original = await makeContractFixture();
  });

  it('prints a wrapped note inside its field and a link as its label and address', async () => {
    const base = await input(original);
    const out = await buildSealedPdf({
      ...base,
      fields: [
        ...base.fields,
        { page: 1, rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.08 }, kind: 'note', text: NOTE },
        { page: 3, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, kind: 'note', text: 'Rotated page note' },
        { page: 1, rect: { x: 0.1, y: 0.3, w: 0.6, h: 0.03 }, kind: 'text', text: 'Our terms (https://example.com/terms)' },
      ],
    });
    const pages = await extractText(out.sealed);
    expect(pages[0].text).toContain('Payment is due within thirty days');
    expect(pages[0].text).toContain('Our terms (https://example.com/terms)');
    expect(pages[2].text).toContain('Rotated page note');
    // every line of the note starts inside the field's box (page 1 is 612 x 792 pt, upright):
    // x from 0.1 to 0.5 of the width, y from 0.2 to 0.28 of the height measured from the top
    const noteRuns = pages[0].items.filter((i) => /Payment|Late|payments|compounded|monthly|interest|statutory/.test(i.str));
    expect(noteRuns.length).toBeGreaterThan(1); // it wrapped onto more than one line
    for (const run of noteRuns) {
      expect(run.x).toBeGreaterThanOrEqual(612 * 0.1 - 0.5);
      expect(run.x).toBeLessThanOrEqual(612 * 0.5);
      expect(run.y).toBeGreaterThanOrEqual(792 * (1 - 0.28) - 0.5);
      expect(run.y).toBeLessThanOrEqual(792 * (1 - 0.2));
    }
  });

  it('draws a tick box ticked or empty on every page orientation, and a long note never fails', async () => {
    const base = await input(original);
    const ticked = await buildSealedPdf({ ...base, fields: [...base.fields, ...[1, 3, 5].map((page) => ({ page, rect: { x: 0.4, y: 0.4, w: 0.03, h: 0.02 }, kind: 'check' as const, checked: true }))] });
    const empty = await buildSealedPdf({ ...base, fields: [...base.fields, ...[1, 3, 5].map((page) => ({ page, rect: { x: 0.4, y: 0.4, w: 0.03, h: 0.02 }, kind: 'check' as const, checked: false }))] });
    expect(sha(ticked.sealed)).not.toBe(sha(empty.sealed));
    expect(ticked.warnings.length).toBe(empty.warnings.length);
    const tiny = await buildSealedPdf({ ...base, fields: [...base.fields, { page: 4, rect: { x: 0.1, y: 0.1, w: 0.05, h: 0.01 }, kind: 'note', text: `${NOTE} ${'Supercalifragilisticexpialidocious'.repeat(5)}` }] });
    expect(tiny.sealed.length).toBeGreaterThan(0);
  });
});
