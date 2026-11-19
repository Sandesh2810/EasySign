// AT3.1: the sealed PDF carries a cryptographic signature that an independent check accepts,
// and any change to the file afterwards is reported.
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildSealedPdf, type SealInput, type SealOutput } from './seal';
import { checkPdfSeal } from './verify-seal';
import { loadSealKey, type SealKey } from './seal-key';
import { makeContractFixture, makeSignaturePng, extractText } from './test-fixtures';
import { createSealP12 } from '../../scripts/lib/seal-key.mjs';

const CODE = 'ES-2611-QR2S-WZPC-4YEW-H9';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sealedAt = new Date('2026-11-19T10:06:00Z');
// made fresh for each run, so no passphrase is written into the repository
const PASSPHRASE = randomBytes(24).toString('base64url');
const WRONG = randomBytes(24).toString('base64url');

async function input(original: Uint8Array, seal?: SealInput['seal']): Promise<SealInput> {
  const png = makeSignaturePng();
  return {
    original,
    envelope: {
      id: '11111111-1111-4111-8111-111111111111',
      publicCode: CODE,
      title: 'Seal signature test',
      originalSha256: sha(original),
      verifyUrl: `https://www.younmesign.com/verify?code=${CODE}`,
      completedAtUtc: new Date('2026-11-19T10:05:00Z'),
      sender: { name: 'Sandra Sender', email: 'sender@example.test' },
    },
    recipients: [
      {
        id: 'r1', name: 'Alice Example', email: 'alice@example.test', role: 'signer', order: 1, authMethod: 'link',
        consentVersion: 'esign-consent-2026-11-v2', signatureMethod: 'drawn', ip: '203.0.113.7', userAgent: 'Mozilla/5.0', region: null,
        timeline: { sent: new Date('2026-11-19T09:00:00Z'), consented: new Date('2026-11-19T09:56:00Z'), completed: new Date('2026-11-19T10:05:00Z') },
      },
    ],
    fields: [
      { page: 1, rect: { x: 0.1, y: 0.8, w: 0.35, h: 0.08 }, kind: 'signature', imagePng: png, signerName: 'Alice Example', signedAtUtc: new Date('2026-11-19T10:05:00Z'), signatureId: `${CODE}-S1` },
    ],
    audit: { checkpointSeq: 9, checkpointHash: 'ab'.repeat(32) },
    seal,
  };
}

/** a copy of the file with one byte changed */
function flip(pdf: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(pdf);
  copy[at] = copy[at] === 0x41 ? 0x42 : 0x41;
  return copy;
}

describe('cryptographic seal (AT3.1)', () => {
  let key: SealKey;
  let out: SealOutput;
  let plain: SealOutput;

  beforeAll(async () => {
    const made = createSealP12({ passphrase: PASSPHRASE });
    key = loadSealKey(made.p12.toString('base64'), PASSPHRASE);
    expect(key.certSha256).toBe(made.certSha256);
    const original = await makeContractFixture();
    out = await buildSealedPdf(await input(original, { key, signingTime: sealedAt }));
    plain = await buildSealedPdf(await input(original));
  }, 60_000);

  it('signs the sealed file, and the independent check accepts it', () => {
    const c = checkPdfSeal(out.sealed);
    expect(c.problem).toBeNull();
    expect(c).toMatchObject({ signed: true, intact: true, coversWholeFile: true, digestMatches: true, signatureValid: true, subFilter: 'adbe.pkcs7.detached' });
    expect(c.signerCertSha256).toBe(key.certSha256);
    expect(c.signerSubject).toContain('YouNMeSign document seal');
    expect(c.signingTime?.toISOString()).toBe(sealedAt.toISOString());
    expect(out.sealKeyId).toBe(key.certSha256);
  });

  it('pre-seal hash = the digest the signature covers; final hash = the whole signed file', () => {
    const c = checkPdfSeal(out.sealed);
    expect(out.presealSha256).toBe(c.computedDigest);
    expect(out.presealSha256).toBe(c.signedDigest);
    expect(out.finalSha256).toBe(sha(out.sealed));
    expect(out.presealSha256).not.toBe(out.finalSha256);
    // the standalone certificate states both
    const standalone = Buffer.from(out.certificate).toString('latin1');
    expect(standalone.length).toBeGreaterThan(0);
  });

  it('has what PDF readers look for: a signature field, the standard handler, "signatures exist" flags', () => {
    const t = Buffer.from(out.sealed).toString('latin1');
    expect(t).toMatch(/\/FT\s*\/Sig/);
    expect(t).toMatch(/\/Filter\s*\/Adobe\.PPKLite/);
    expect(t).toMatch(/\/SigFlags\s+3/);
    expect([...t.matchAll(/\/ByteRange\s*\[/g)]).toHaveLength(1);
  });

  it('still opens and its text can still be read after signing', async () => {
    const pages = await extractText(out.sealed);
    expect(pages.length).toBe(out.pageCount);
    expect(pages.map((p) => p.text).join(' ')).toContain('Certificate of Completion');
  });

  it('one byte changed before the signature → "modified"', () => {
    const c = checkPdfSeal(flip(out.sealed, 2000));
    expect(c.intact).toBe(false);
    expect(c.digestMatches).toBe(false);
    expect(c.problem).toMatch(/modified/);
  });

  it('one byte changed after the signature → "modified"', () => {
    const c = checkPdfSeal(flip(out.sealed, out.sealed.length - 200));
    expect(c.intact).toBe(false);
    expect(c.digestMatches).toBe(false);
  });

  it('one byte changed inside the signature itself → not intact', () => {
    const t = Buffer.from(out.sealed).toString('latin1');
    const m = [...t.matchAll(/\/ByteRange\s*\[\s*0\s+(\d+)/g)][0];
    const sigStart = Number(m[1]) + 1; // first hex digit after '<'
    const copy = Uint8Array.from(out.sealed);
    copy[sigStart + 400] = copy[sigStart + 400] === 0x30 ? 0x31 : 0x30; // a hex digit inside the real signature
    const c = checkPdfSeal(copy);
    expect(c.intact).toBe(false);
  });

  it('bytes appended after sealing → not intact', () => {
    const longer = new Uint8Array(out.sealed.length + 5);
    longer.set(out.sealed);
    longer.set([0x25, 0x25, 0x45, 0x4f, 0x46], out.sealed.length);
    const c = checkPdfSeal(longer);
    expect(c.intact).toBe(false);
    expect(c.coversWholeFile).toBe(false);
  });

  it('without a key the file is not signed, and the check says so', () => {
    const c = checkPdfSeal(plain.sealed);
    expect(c.signed).toBe(false);
    expect(c.intact).toBe(false);
    expect(plain.sealKeyId).toBeNull();
    expect(plain.presealSha256).toBe(plain.finalSha256);
  });

  it('refuses a wrong passphrase or an expired certificate, without repeating the passphrase', () => {
    const made = createSealP12({ passphrase: PASSPHRASE, bits: 2048 });
    expect(() => loadSealKey(made.p12.toString('base64'), WRONG)).toThrow(/passphrase is wrong/);
    try {
      loadSealKey(made.p12.toString('base64'), WRONG);
    } catch (e) {
      expect(String(e)).not.toContain(WRONG);
    }
    const old = createSealP12({ passphrase: PASSPHRASE, bits: 2048, years: 1, now: new Date('2020-01-01T00:00:00Z') });
    expect(() => loadSealKey(old.p12.toString('base64'), PASSPHRASE)).toThrow(/expired/);
    expect(() => loadSealKey('', PASSPHRASE)).toThrow(/not configured/);
  });
});
