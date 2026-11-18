// Creating and re-deriving signer links (DECISIONS D-21, D-23). Server-only.
// A link is https://<app>/s#<token>. The token sits after the "#", which browsers never send to any
// server, so it cannot land in access logs. The token itself is derived from SIGNER_TOKEN_KEY and is
// never stored: the database holds the token id, a random nonce and the SHA-256 of the token.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { deriveToken, hashToken, newNonce } from '@/lib/signer-token';

export interface TokenRecord {
  recipient_id: string;
  token_id: string;
  /** hex */
  nonce: string;
  /** hex */
  token_sha256: string;
}

/** A fresh token record for a recipient, in the shape send_envelope expects. */
export function mintTokenRecord(recipientId: string): TokenRecord {
  const tokenId = randomUUID();
  const nonce = newNonce();
  const token = deriveToken(env.signerTokenKey(), tokenId, nonce);
  return { recipient_id: recipientId, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') };
}

/** Postgres returns bytea as "\x…" hex through the API. */
export function byteaToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/^\\x/, ''), 'hex');
}

/** Re-derive the link for an existing token row (first email, reminder, "copy link" all give the same link). */
export function signingLink(tokenId: string, nonce: Buffer): string {
  return `${env.appUrl()}/s#${deriveToken(env.signerTokenKey(), tokenId, nonce)}`;
}
