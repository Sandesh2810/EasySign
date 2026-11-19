// Creates the self-signed seal certificate (PKCS#12) that signs every sealed PDF (Phase 3, AT3.1).
// Plain JavaScript so that both scripts/setup-env.mjs and the tests can use it. No secrets are printed.
// Self-signed on purpose ($0): Acrobat will say the signer's identity is unknown, but it still reports
// whether the file was changed after sealing. A CA-issued certificate is the paid upgrade (KNOWN_LIMITATIONS).
import forge from 'node-forge';
import { createHash, randomBytes } from 'node:crypto';

/**
 * @param {{ passphrase: string, commonName?: string, organization?: string, years?: number, now?: Date, bits?: number }} opts
 * @returns {{ p12: Buffer, certSha256: string, notAfter: Date }}
 */
export function createSealP12(opts) {
  const { passphrase, commonName = 'YouNMeSign document seal', organization = 'YouNMeSign', years = 10, now = new Date(), bits = 3072 } = opts;
  if (!passphrase || passphrase.length < 16) throw new Error('The seal passphrase must be at least 16 characters.');
  const keys = forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // positive serial: a leading 0x01 byte keeps the top bit clear
  cert.serialNumber = '01' + randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: organization },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: 'aes256', friendlyName: commonName });
  const p12 = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  return { p12, certSha256: createHash('sha256').update(certDer).digest('hex'), notAfter };
}

/** A random passphrase for the seal key: 32 bytes, URL-safe. */
export function newSealPassphrase() {
  return randomBytes(32).toString('base64url');
}
