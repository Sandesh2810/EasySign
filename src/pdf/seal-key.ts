// Loads and checks the seal certificate (PKCS#12) used to sign sealed PDFs (Phase 3, AT3.1).
// Server/worker only. The P12 and its passphrase come from the environment (SEAL_P12_BASE64,
// SEAL_P12_PASSPHRASE) and are never logged; only the certificate's SHA-256 fingerprint (the "key id") is.
import forge from 'node-forge';
import { createHash } from 'node:crypto';

export interface SealKey {
  p12: Buffer;
  passphrase: string;
  /** SHA-256 of the certificate (DER), lower-case hex: the key id written to logs and the audit trail */
  certSha256: string;
  subject: string;
  notAfter: Date;
}

/** Opens the P12 with its passphrase and returns the key. Throws a plain message (never the passphrase) on any problem. */
export function loadSealKey(p12Base64: string, passphrase: string, now: Date = new Date()): SealKey {
  if (!p12Base64 || !passphrase) throw new Error('The seal certificate is not configured (SEAL_P12_BASE64 and SEAL_P12_PASSPHRASE).');
  const p12 = Buffer.from(p12Base64, 'base64');
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary'))), false, passphrase);
  } catch {
    throw new Error('The seal certificate could not be opened: the file or its passphrase is wrong.');
  }
  const keyBag = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  const certBags = parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keyBag?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error('The seal certificate contains no private key.');
  const cert = certBags
    .map((b) => b.cert)
    .find((c): c is forge.pki.Certificate => {
      const pub = c?.publicKey as forge.pki.rsa.PublicKey | undefined;
      return Boolean(pub && pub.n.compareTo(key.n) === 0 && pub.e.compareTo(key.e) === 0);
    });
  if (!cert) throw new Error('The seal certificate does not match its private key.');
  if (cert.validity.notAfter.getTime() <= now.getTime()) throw new Error(`The seal certificate expired on ${cert.validity.notAfter.toISOString().slice(0, 10)}.`);
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const subject = cert.subject.attributes.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ');
  return { p12, passphrase, certSha256: createHash('sha256').update(der).digest('hex'), subject, notAfter: cert.validity.notAfter };
}
