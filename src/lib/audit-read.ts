// A document's whole audit trail, wherever it is kept (Phase 3 slice 7, D-72): archived parts (compressed files in
// storage, each checked against the SHA-256 recorded in the database) followed by the rows still in the database,
// verified as one chain from the first event. Server-only: call it only after checking the person may see the document.
import 'server-only';
import { decodeArchive, sha256Hex } from '@/lib/audit-archive-format';
import { verifyChain, type AuditRow, type VerifyResult } from '@/lib/audit-chain';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorage } from '@/storage';

export interface AuditTrail {
  chainKey: string;
  rows: AuditRow[];
  archivedParts: { firstSeq: number; lastSeq: number; fileSha256: string; fileOk: boolean }[];
  verify: VerifyResult;
}

const COLUMNS = 'chain_key, chain_seq, id, org_id, envelope_id, recipient_id, actor_type, actor_id, event_type, payload, ip, user_agent, created_at, canonical, prev_hash, event_hash';
const hex = (v: unknown) => (typeof v === 'string' ? v.replace(/^\\x/, '').toLowerCase() : '');

export async function loadAuditTrail(envelopeId: string): Promise<AuditTrail> {
  const db = supabaseAdmin();
  const chainKey = `env:${envelopeId}`;
  const { data: parts, error: partsError } = await db
    .from('audit_archives')
    .select('first_seq, last_seq, storage_path, file_sha256')
    .eq('chain_key', chainKey)
    .order('first_seq');
  if (partsError) throw new Error('the archived audit parts could not be listed');

  const rows: AuditRow[] = [];
  const archivedParts: AuditTrail['archivedParts'] = [];
  for (const p of parts ?? []) {
    let fileOk = false;
    try {
      const bytes = await getStorage().get('audit-archives', p.storage_path as string);
      fileOk = sha256Hex(bytes) === p.file_sha256;
      const decoded = decodeArchive(bytes);
      fileOk = fileOk && decoded.header.first_seq === p.first_seq && decoded.header.last_seq === p.last_seq;
      rows.push(...decoded.rows);
    } catch {
      fileOk = false;
    }
    archivedParts.push({ firstSeq: p.first_seq as number, lastSeq: p.last_seq as number, fileSha256: p.file_sha256 as string, fileOk });
  }

  // the database part, in pages (a long trail can exceed one response)
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('audit_events').select(COLUMNS).eq('chain_key', chainKey).order('chain_seq').range(from, from + 999);
    if (error) throw new Error('the audit events could not be read');
    for (const r of data ?? []) {
      rows.push({
        ...(r as unknown as AuditRow),
        ip: (r.ip as string | null) ?? null,
        prev_hash: hex(r.prev_hash),
        event_hash: hex(r.event_hash),
      });
    }
    if (!data || data.length < 1000) break;
  }

  const verify = verifyChain(rows);
  const allFilesOk = archivedParts.every((p) => p.fileOk);
  return { chainKey, rows, archivedParts, verify: allFilesOk ? verify : { ...verify, ok: false, reason: verify.reason ?? 'an archived part is missing or was changed' } };
}
