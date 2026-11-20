// Moves the audit events of finished documents into compressed files (Phase 3 slice 7, AT3.10, D-72).
// Order: read the rows -> verify them here -> write the file -> read it back and compare -> commit in the database
// (which re-verifies and removes exactly that range). If the commit fails, the file is removed again; the rows stay.
import { archivePath, decodeArchive, encodeArchive, sha256Hex } from '@/lib/audit-archive-format';
import { hashEvent, verifyChain, type AuditRow } from '@/lib/audit-chain';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorage } from '@/storage';

/** Finished documents are archived after this many days (their trail rarely changes after that). */
export const ARCHIVE_AFTER_DAYS = 30;

const hex = (v: unknown) => (typeof v === 'string' ? v.replace(/^\\x/, '').toLowerCase() : '');

export async function archiveOne(envelopeId: string, log: (m: string) => void): Promise<boolean> {
  const db = supabaseAdmin();
  const chainKey = `env:${envelopeId}`;
  const [{ data: env }, { data: prior }] = await Promise.all([
    db.from('envelopes').select('org_id').eq('id', envelopeId).single(),
    db.from('audit_archives').select('last_seq, head_hash').eq('chain_key', chainKey).order('last_seq', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!env) throw new Error('document not found');
  const { data, error } = await db.rpc('audit_archive_rows', { p_chain_key: chainKey });
  if (error) throw new Error(`audit_archive_rows: ${error.message}`);
  const rows = (data ?? []) as AuditRow[];
  if (rows.length === 0) return false;

  // the rows must continue the archived part (or start the chain) and verify as a chain
  const startSeq = (prior?.last_seq as number | undefined) ?? 0;
  const startHash = prior ? hex(prior.head_hash) : '0'.repeat(64);
  if (rows[0].chain_seq !== startSeq + 1 || rows[0].prev_hash !== startHash) throw new Error('the rows do not continue the archived part');
  if (startSeq === 0) {
    const v = verifyChain(rows);
    if (!v.ok) throw new Error(`the chain does not verify: ${v.reason}`);
  } else {
    // a later part: walk the links and hashes from the archived head (the database checks the columns again at commit)
    let prev = startHash;
    for (const [i, r] of rows.entries()) {
      if (r.chain_seq !== startSeq + 1 + i || r.prev_hash !== prev || hashEvent(prev, r.canonical) !== r.event_hash) {
        throw new Error(`the chain does not verify at event ${r.chain_seq}`);
      }
      prev = r.event_hash;
    }
  }

  const file = encodeArchive(rows);
  const back = decodeArchive(file.bytes);
  if (back.rows.length !== rows.length || back.header.head_hash !== rows[rows.length - 1].event_hash) throw new Error('the archive file did not read back');
  const path = archivePath(env.org_id as string, envelopeId, file.header.first_seq, file.header.last_seq);
  const storage = getStorage();
  await storage.put('audit-archives', path, file.bytes, { contentType: 'application/gzip' });
  const stored = await storage.get('audit-archives', path);
  if (sha256Hex(stored) !== file.sha256) {
    await storage.remove('audit-archives', path).catch(() => {});
    throw new Error('the stored archive file differs from what was written');
  }
  const commit = await db.rpc('audit_archive_commit', {
    p_chain_key: chainKey,
    p_first_seq: file.header.first_seq,
    p_last_seq: file.header.last_seq,
    p_head_hash: file.header.head_hash,
    p_storage_path: path,
    p_file_sha256: file.sha256,
  });
  if (commit.error) {
    await storage.remove('audit-archives', path).catch(() => {});
    throw new Error(`audit_archive_commit: ${commit.error.message}`);
  }
  log(`audit archived: ${chainKey} events ${file.header.first_seq}-${file.header.last_seq} (${file.bytes.length} bytes)`);
  return true;
}

/** Archives up to `limit` due documents. Returns how many were archived. */
export async function archiveDue(log: (m: string) => void, minAgeDays = ARCHIVE_AFTER_DAYS, limit = 5, envelopeId: string | null = null): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('audit_archive_due', { p_min_age_days: minAgeDays, p_limit: limit, p_envelope_id: envelopeId });
  if (error) throw new Error(`audit_archive_due: ${error.message}`);
  let done = 0;
  for (const d of (data ?? []) as { envelope_id: string }[]) {
    try {
      if (await archiveOne(d.envelope_id, log)) done += 1;
    } catch (e) {
      log(`audit archive of ${d.envelope_id} failed (rows kept): ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }
  return done;
}
