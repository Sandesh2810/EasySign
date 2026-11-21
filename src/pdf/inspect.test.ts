import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { inflatesWithinLimits, inspectPdf } from './inspect';
import { makeContractFixture, makeBlankPdf, makeHostilePdf } from './test-fixtures';

describe('inspectPdf: accepts ordinary contracts', () => {
  it('reads page count, hash, size and the visible box of every page', async () => {
    const bytes = await makeContractFixture();
    const r = await inspectPdf(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pageCount).toBe(5);
    expect(r.sizeBytes).toBe(bytes.length);
    expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(r.pages).toEqual([
      { x: 0, y: 0, width: 612, height: 792, rotate: 0 },
      { x: 0, y: 0, width: 792, height: 612, rotate: 0 },
      { x: 0, y: 0, width: 612, height: 792, rotate: 90 },
      { x: 50, y: 60, width: 512, height: 672, rotate: 0 },
      { x: 0, y: 0, width: 500, height: 700, rotate: 270 },
    ]);
  });

  it('allows a plain "open at page 1" action and ordinary web links (links are counted, never clickable in our viewer)', async () => {
    const goto_ = await inspectPdf(await makeHostilePdf('open-goto'));
    expect(goto_.ok).toBe(true);
    const link = await inspectPdf(await makeHostilePdf('link'));
    expect(link.ok).toBe(true);
    if (link.ok) expect(link.linkCount).toBe(1);
  });

  it('does not modify the bytes it is given', async () => {
    const bytes = await makeContractFixture();
    const before = createHash('sha256').update(bytes).digest('hex');
    await inspectPdf(bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(before);
  });
});

describe('inspectPdf: rejects what must not be signed or stored', () => {
  const cases: Array<[Parameters<typeof makeHostilePdf>[0], string]> = [
    ['javascript', 'ACTIVE_CONTENT'],
    ['launch', 'ACTIVE_CONTENT'],
    ['open-uri', 'ACTIVE_CONTENT'],
    ['embedded', 'EMBEDDED_FILES'],
    ['form', 'FORM_FIELDS'],
    ['signed', 'ALREADY_SIGNED'],
    ['encrypted', 'ENCRYPTED'],
  ];
  it.each(cases)('%s -> %s', async (kind, code) => {
    const r = await inspectPdf(await makeHostilePdf(kind));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(code);
      expect(r.message.length).toBeGreaterThan(10); // a sentence a person can act on
    }
  });

  it('rejects files that are not PDFs by their first bytes, whatever they are called', async () => {
    for (const bytes of [new TextEncoder().encode('hello world'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), new Uint8Array(0)]) {
      const r = await inspectPdf(bytes);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NOT_PDF');
    }
  });

  it('rejects a file over 10 MB before parsing it', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode('%PDF-1.7\n'));
    const started = Date.now();
    const r = await inspectPdf(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FILE_TOO_LARGE');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('rejects more than 100 pages and accepts exactly 100', async () => {
    const tooMany = await inspectPdf(await makeBlankPdf(101));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe('TOO_MANY_PAGES');
    expect((await inspectPdf(await makeBlankPdf(100))).ok).toBe(true);
  });

  it('rejects a damaged file with a clear message instead of throwing', async () => {
    const good = await makeContractFixture();
    const truncated = good.slice(0, 300);
    const r = await inspectPdf(truncated);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNREADABLE');
  });
});

describe('inspectPdf: security review fixes (D-89)', () => {
  it('F5: finds a script action however deeply it is nested inside a link', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ctx = doc.context;
    // 20 levels of "go to … then next", all written inline, with a script at the bottom
    let action: Record<string, unknown> = { S: 'JavaScript', JS: PDFString.of('app.alert(1)') };
    for (let i = 0; i < 20; i++) action = { S: 'GoTo', D: [page.ref, 'Fit'], Next: action };
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], A: action } as Parameters<typeof ctx.obj>[0]));
    page.node.set(PDFName.of('Annots'), ctx.obj([annot]));
    const r = await inspectPdf(await doc.save({ useObjectStreams: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ACTIVE_CONTENT');
  });

  it('F4: a small file whose stream unpacks to far more than its size is refused before it is parsed', async () => {
    const zeros = deflateSync(Buffer.alloc(70 * 1024 * 1024)); // 70 MB of zeros, about 70 KB compressed
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    // append an extra compressed object by hand (an incremental-style addition the parser would read)
    const extra = Buffer.concat([Buffer.from('\n99 0 obj\n<< /Length ' + zeros.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'), zeros, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    const withBomb = new Uint8Array(Buffer.concat([bytes, extra]));
    expect(withBomb.length).toBeLessThan(1024 * 1024);
    expect(inflatesWithinLimits(withBomb)).toBe(false);
    const r = await inspectPdf(withBomb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOO_COMPLEX');
  });

  it('F4: ordinary compressed content passes the check', async () => {
    expect(inflatesWithinLimits(await makeContractFixture())).toBe(true);
    expect(inflatesWithinLimits(new Uint8Array(Buffer.concat([Buffer.from('stream\n'), deflateSync(Buffer.alloc(1000)), Buffer.from('\nendstream')])), { perStream: 10_000, total: 10_000 })).toBe(true);
    expect(inflatesWithinLimits(new Uint8Array(Buffer.concat([Buffer.from('stream\n'), deflateSync(Buffer.alloc(20_000)), Buffer.from('\nendstream')])), { perStream: 10_000, total: 1e9 })).toBe(false);
  });
});
