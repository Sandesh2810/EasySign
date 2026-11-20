// The audit archive file (Phase 3 slice 7, AT3.10, D-72). Pure apart from zlib and SHA-256.
// One gzip-compressed file per archived part: line 1 is a header, then one line per audit row with every column,
// including the stored canonical text and both hashes, so the part can be re-verified from the file alone and joined
// to the rows still in the database.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AuditRow } from './audit-chain';

export const ARCHIVE_FORMAT = 'younmesign-audit-archive';

export interface ArchiveHeader {
  format: typeof ARCHIVE_FORMAT;
  v: 1;
  chain_key: string;
  first_seq: number;
  last_seq: number;
  head_hash: string;
}

/** The file name inside the "audit-archives" bucket: {org}/{envelope}/audit-{first}-{last}.jsonl.gz */
export const archivePath = (orgId: string, envelopeId: string, first: number, last: number) => `${orgId}/${envelopeId}/audit-${first}-${last}.jsonl.gz`;

export function encodeArchive(rows: readonly AuditRow[]): { bytes: Uint8Array; header: ArchiveHeader; sha256: string } {
  if (rows.length === 0) throw new Error('nothing to archive');
  const header: ArchiveHeader = {
    format: ARCHIVE_FORMAT,
    v: 1,
    chain_key: rows[0].chain_key,
    first_seq: rows[0].chain_seq,
    last_seq: rows[rows.length - 1].chain_seq,
    head_hash: rows[rows.length - 1].event_hash,
  };
  const text = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n';
  const bytes = new Uint8Array(gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
  return { bytes, header, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Reads a part back. Throws when the file is not one of ours or its header disagrees with its rows. */
export function decodeArchive(bytes: Uint8Array): { header: ArchiveHeader; rows: AuditRow[] } {
  const lines = gunzipSync(Buffer.from(bytes)).toString('utf8').split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0] ?? '{}') as ArchiveHeader;
  if (header.format !== ARCHIVE_FORMAT || header.v !== 1) throw new Error('not a YouNMeSign audit archive');
  const rows = lines.slice(1).map((l) => JSON.parse(l) as AuditRow);
  const last = rows[rows.length - 1];
  if (
    rows.length !== header.last_seq - header.first_seq + 1 ||
    rows[0]?.chain_seq !== header.first_seq ||
    last?.chain_seq !== header.last_seq ||
    last?.event_hash !== header.head_hash ||
    rows.some((r) => r.chain_key !== header.chain_key)
  ) {
    throw new Error('the archive header does not match its rows');
  }
  return { header, rows };
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
