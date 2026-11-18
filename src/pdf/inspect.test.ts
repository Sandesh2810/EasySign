import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { inspectPdf } from './inspect';
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
