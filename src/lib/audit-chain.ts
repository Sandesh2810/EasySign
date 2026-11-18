// Audit hash chain (DECISIONS D-25).
// event_hash = SHA-256(prev_hash bytes || UTF-8 bytes of the stored canonical text).
// The database builds and stores `canonical` when it inserts an event; this module
// (a) reproduces the hash, (b) checks the stored text still agrees with the row's columns,
// (c) checks sequence, linkage and optional checkpoints. It never needs to reproduce
// the database's exact JSON formatting, only to parse it.
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEventInput {
  chain_key: string;
  chain_seq: number;
  id: string;
  org_id: string | null;
  envelope_id: string | null;
  recipient_id: string | null;
  actor_type: string;
  actor_id: string | null;
  event_type: string;
  payload: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface AuditRow extends AuditEventInput {
  canonical: string;
  prev_hash: string;
  event_hash: string;
}

const FIELDS = [
  'chain_key',
  'chain_seq',
  'id',
  'org_id',
  'envelope_id',
  'recipient_id',
  'actor_type',
  'actor_id',
  'event_type',
  'payload',
  'ip',
  'user_agent',
  'created_at',
] as const;

/** Deterministic JSON: object keys sorted, no whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

/** Normalise a timestamp to YYYY-MM-DDTHH:MM:SS.ffffffZ (UTC, microseconds) without losing precision. */
export function normaliseTimestamp(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]00(?::?00)?)$/.exec(ts.trim());
  if (!m) throw new Error(`Timestamp is not UTC or not parseable: ${ts}`);
  return `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(6, '0')}Z`;
}

/** Canonical text for an event. Used in tests and exports; the database produces the stored text in production. */
export function buildCanonical(ev: AuditEventInput): string {
  const picked: Record<string, unknown> = { v: 1 };
  for (const f of FIELDS) picked[f] = f === 'created_at' ? normaliseTimestamp(ev.created_at) : (ev[f] ?? null);
  return stableStringify(picked);
}

const hex = (h: string) => h.replace(/^\\x/, '').toLowerCase();

export function hashEvent(prevHashHex: string, canonical: string): string {
  return createHash('sha256')
    .update(Buffer.from(hex(prevHashHex), 'hex'))
    .update(Buffer.from(canonical, 'utf8'))
    .digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  head: string;
  /** chain_seq of the first offending row, when there is one */
  brokenAt?: number;
  reason?: string;
}

export interface VerifyOptions {
  /** A (sequence, hash) pair recorded outside the live table: in a sealed PDF or a checkpoint file. */
  checkpoint?: { seq: number; hash: string };
}

/** Verify one chain. Rows must be supplied in chain order. */
export function verifyChain(rows: readonly AuditRow[], opts: VerifyOptions = {}): VerifyResult {
  let prev = GENESIS_HASH;
  const fail = (row: AuditRow, i: number, reason: string): VerifyResult => ({ ok: false, count: i, head: prev, brokenAt: row.chain_seq, reason });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.chain_key !== rows[0].chain_key) return fail(row, i, 'row belongs to a different chain');
    if (row.chain_seq !== i + 1) return fail(row, i, `sequence gap: expected ${i + 1}, found ${row.chain_seq}`);
    if (hex(row.prev_hash) !== prev) return fail(row, i, 'prev link does not match the previous event');
    if (hashEvent(prev, row.canonical) !== hex(row.event_hash)) return fail(row, i, 'event hash does not match the stored text');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.canonical) as Record<string, unknown>;
    } catch {
      return fail(row, i, 'stored text is not valid JSON');
    }
    for (const f of FIELDS) {
      const stored = f === 'created_at' ? normaliseTimestamp(String(parsed[f])) : (parsed[f] ?? null);
      const column = f === 'created_at' ? normaliseTimestamp(row.created_at) : (row[f] ?? null);
      if (stableStringify(stored) !== stableStringify(column)) return fail(row, i, `column ${f} disagrees with the hashed text`);
    }
    prev = hex(row.event_hash);
  }

  const result: VerifyResult = { ok: true, count: rows.length, head: prev };
  const cp = opts.checkpoint;
  if (cp) {
    if (rows.length < cp.seq) return { ...result, ok: false, reason: `chain is shorter (${rows.length}) than its checkpoint (${cp.seq})` };
    if (hex(rows[cp.seq - 1].event_hash) !== hex(cp.hash)) return { ...result, ok: false, brokenAt: cp.seq, reason: 'checkpoint hash does not match the chain' };
  }
  return result;
}
