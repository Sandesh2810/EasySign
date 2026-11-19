// Independent check of a sealed PDF's cryptographic signature (Phase 3, AT3.1).
// Written separately from the signing library on purpose: it re-derives everything from the file bytes.
//   1. find the signature's /ByteRange [a b c d] and its /Contents <hex>
//   2. the byte range must cover the whole file except exactly the /Contents hex string
//   3. SHA-256 over the two covered ranges must equal the messageDigest the signature carries
//   4. the RSA signature over the signed attributes must verify with the embedded certificate (Node crypto)
// node-forge is used only to read the ASN.1 structure; the digest and the RSA check use Node's own crypto.
// Pure function: no network, no database. Used by the tests, and by the worker to check its own output
// before anything is stored ("a broken seal is worse than no seal").
import forge from 'node-forge';
import { createHash, X509Certificate, verify as rsaVerify } from 'node:crypto';

export interface SealCheck {
  /** a signature with a byte range and contents exists */
  signed: boolean;
  /** every check below passed */
  intact: boolean;
  coversWholeFile: boolean;
  digestMatches: boolean;
  signatureValid: boolean;
  /** SHA-256 over the signed byte ranges, recomputed from the file */
  computedDigest: string | null;
  /** the messageDigest the signature says it signed */
  signedDigest: string | null;
  /** SHA-256 of the signer certificate (DER): compare with the seal key id */
  signerCertSha256: string | null;
  signerSubject: string | null;
  signingTime: Date | null;
  subFilter: string | null;
  /** plain-language reason when not intact */
  problem: string | null;
}

const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signedData: '1.2.840.113549.1.7.2',
};

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');

function empty(problem: string, signed = false): SealCheck {
  return {
    signed, intact: false, coversWholeFile: false, digestMatches: false, signatureValid: false,
    computedDigest: null, signedDigest: null, signerCertSha256: null, signerSubject: null, signingTime: null, subFilter: null, problem,
  };
}

const isContext = (n: forge.asn1.Asn1, tag: number) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === tag;
const children = (n: forge.asn1.Asn1 | undefined) => (n && Array.isArray(n.value) ? (n.value as forge.asn1.Asn1[]) : []);
const oidOf = (n: forge.asn1.Asn1 | undefined) => (n && typeof n.value === 'string' ? forge.asn1.derToOid(n.value) : '');

export function checkPdfSeal(pdf: Uint8Array): SealCheck {
  const text = latin1(pdf);
  // the last signature in the file is the one that has to cover everything
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (ranges.length === 0) return empty('The file has no cryptographic signature.');
  const m = ranges[ranges.length - 1];
  const [a, b, c, d] = m.slice(1, 5).map(Number);
  const subFilter = [...text.matchAll(/\/SubFilter\s*\/([A-Za-z0-9.]+)/g)].at(-1)?.[1] ?? null;

  const gap = text.slice(b, c);
  const gapIsContents = c > b + 1 && /^<[0-9A-Fa-f]*>$/.test(gap);
  const coversWholeFile = a === 0 && b > 0 && gapIsContents && c + d === pdf.length;
  const result: SealCheck = { ...empty('', true), subFilter, coversWholeFile };
  if (!gapIsContents) return { ...result, problem: 'The signature does not sit where its byte range says.' };

  const covered = Buffer.concat([Buffer.from(pdf.subarray(a, a + b)), Buffer.from(pdf.subarray(c, Math.min(pdf.length, c + d)))]);
  result.computedDigest = createHash('sha256').update(covered).digest('hex');

  let attrsDer: Buffer;
  let signature: Buffer;
  let certNode: forge.asn1.Asn1 | undefined;
  try {
    const der = Buffer.from(gap.slice(1, -1), 'hex');
    // the hex is zero-padded after the real signature; read just the first DER element
    const root = forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary')), { strict: false, parseAllBytes: false } as never);
    if (oidOf(children(root)[0]) !== OID.signedData) throw new Error('not signed data');
    const signedData = children(children(root)[1])[0];
    const parts = children(signedData);
    const certs = parts.find((n) => isContext(n, 0));
    const signerInfos = parts[parts.length - 1];
    const signerInfo = children(signerInfos)[0];
    const si = children(signerInfo);
    // [version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature]
    const sid = si[1];
    if (oidOf(children(si[2])[0]) !== OID.sha256) throw new Error('the signature does not use SHA-256');
    const signedAttrs = si.find((n) => isContext(n, 0));
    if (!signedAttrs) throw new Error('no signed attributes');
    const sigNode = si[si.length - 1];
    signature = Buffer.from(sigNode.value as string, 'binary');
    // the signature covers the attributes encoded as a SET (tag 0x31), not as the [0] they are stored under
    const asSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, children(signedAttrs));
    attrsDer = Buffer.from(forge.asn1.toDer(asSet).getBytes(), 'binary');
    for (const attr of children(signedAttrs)) {
      const [type, values] = children(attr);
      const v = children(values)[0];
      if (oidOf(type) === OID.messageDigest) result.signedDigest = Buffer.from(v.value as string, 'binary').toString('hex');
      if (oidOf(type) === OID.signingTime) result.signingTime = forge.asn1.utcTimeToDate(v.value as string);
    }
    // pick the certificate named by the signer info (issuer + serial)
    const wantSerial = forge.util.bytesToHex(children(sid)[1]?.value as string);
    certNode = children(certs).find((n) => {
      const cert = forge.pki.certificateFromAsn1(n);
      return cert.serialNumber.replace(/^0+/, '') === wantSerial.replace(/^0+/, '');
    });
    if (!certNode) throw new Error('the signer certificate is not in the signature');
  } catch (e) {
    return { ...result, problem: `The signature could not be read (${e instanceof Error ? e.message : 'unknown error'}).` };
  }

  const certDer = Buffer.from(forge.asn1.toDer(certNode).getBytes(), 'binary');
  const cert = forge.pki.certificateFromAsn1(certNode);
  result.signerCertSha256 = createHash('sha256').update(certDer).digest('hex');
  result.signerSubject = cert.subject.attributes.map((x) => `${x.shortName ?? x.name}=${x.value}`).join(', ');
  result.digestMatches = result.signedDigest !== null && result.signedDigest === result.computedDigest;
  try {
    result.signatureValid = rsaVerify('sha256', attrsDer, new X509Certificate(certDer).publicKey, signature);
  } catch {
    result.signatureValid = false;
  }

  result.intact = result.coversWholeFile && result.digestMatches && result.signatureValid;
  result.problem = result.intact
    ? null
    : !result.coversWholeFile
      ? 'Bytes were added to or removed from the file after it was sealed.'
      : !result.digestMatches
        ? 'The file was modified after it was sealed.'
        : 'The cryptographic signature does not verify.';
  return result;
}
