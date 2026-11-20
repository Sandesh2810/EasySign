import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { GENESIS_HASH, buildCanonical, hashEvent, verifyChain, type AuditEventInput, type AuditRow } from './audit-chain';
import { archivePath, decodeArchive, encodeArchive, sha256Hex } from './audit-archive-format';

function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const ev: AuditEventInput = {
      chain_key: 'env:11111111-1111-4111-8111-111111111111',
      chain_seq: i,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      org_id: '22222222-2222-4222-8222-222222222222',
      envelope_id: '11111111-1111-4111-8111-111111111111',
      recipient_id: null,
      actor_type: 'system',
      actor_id: null,
      event_type: 'field_filled',
      payload: { n: i, note: 'ünïcode ✓' },
      ip: '203.0.113.7',
      user_agent: 'vitest',
      created_at: `2026-11-17T10:00:${String(i).padStart(2, '0')}.000000Z`,
    };
    const canonical = buildCanonical(ev);
    const event_hash = hashEvent(prev, canonical);
    rows.push({ ...ev, canonical, prev_hash: prev, event_hash });
    prev = event_hash;
  }
  return rows;
}

describe('audit archive file (AT3.10)', () => {
  it('round-trips every column; the archived part plus the remaining rows verify as one chain with the same head', () => {
    const all = chain(12);
    const part = encodeArchive(all.slice(0, 8));
    expect(part.header).toMatchObject({ first_seq: 1, last_seq: 8, head_hash: all[7].event_hash });
    expect(part.sha256).toBe(sha256Hex(part.bytes));
    const back = decodeArchive(part.bytes);
    expect(back.rows).toEqual(all.slice(0, 8));
    const joined = [...back.rows, ...all.slice(8)];
    expect(verifyChain(joined)).toMatchObject({ ok: true, count: 12, head: all[11].event_hash });
  });

  it('a changed archived event is detected by the chain check', () => {
    const all = chain(5);
    const { bytes } = encodeArchive(all);
    const text = gunzipSync(Buffer.from(bytes)).toString('utf8').replace('"n":3', '"n":4');
    const tampered = decodeArchive(new Uint8Array(gzipSync(Buffer.from(text, 'utf8'))));
    const result = verifyChain(tampered.rows);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it('refuses files that are not ours or whose header disagrees with the rows', () => {
    expect(() => decodeArchive(new Uint8Array(gzipSync(Buffer.from('{"format":"other"}\n'))))).toThrow(/not a YouNMeSign/);
    const all = chain(3);
    const { bytes } = encodeArchive(all);
    const lines = gunzipSync(Buffer.from(bytes)).toString('utf8').split('\n');
    lines.splice(2, 1); // drop a row
    expect(() => decodeArchive(new Uint8Array(gzipSync(Buffer.from(lines.join('\n')))))).toThrow(/header does not match/);
    expect(() => encodeArchive([])).toThrow();
  });

  it('names the file the way the database expects', () => {
    expect(archivePath('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 14)).toMatch(
      /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/audit-[0-9]+-[0-9]+\.jsonl\.gz$/,
    );
  });
});
