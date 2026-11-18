import { describe, it, expect } from 'vitest';
import { GENESIS_HASH, hashEvent, buildCanonical, verifyChain, type AuditRow, type AuditEventInput } from './audit-chain';

function makeChain(n: number, chainKey = 'env:11111111-1111-4111-8111-111111111111'): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const ev: AuditEventInput = {
      chain_key: chainKey,
      chain_seq: i,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      org_id: '22222222-2222-4222-8222-222222222222',
      envelope_id: '11111111-1111-4111-8111-111111111111',
      recipient_id: null,
      actor_type: 'system',
      actor_id: null,
      event_type: i === 1 ? 'envelope_created' : 'field_filled',
      payload: { n: i, note: 'ünïcode ✓', nested: { b: 2, a: 1 } },
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

describe('audit chain', () => {
  it('genesis is 32 zero bytes in hex', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });

  it('hash is SHA-256(prev bytes || canonical utf8)', () => {
    // sha256 of 32 zero bytes followed by "a"
    expect(hashEvent(GENESIS_HASH, 'a')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEvent(GENESIS_HASH, 'a')).not.toBe(hashEvent(GENESIS_HASH, 'b'));
    expect(hashEvent(GENESIS_HASH, 'a')).not.toBe(hashEvent('1'.repeat(64), 'a'));
  });

  it('canonical text is stable regardless of key order', () => {
    const a = buildCanonical({ ...makeChain(1)[0], payload: { x: 1, y: { b: 1, a: 2 } } });
    const b = buildCanonical({ ...makeChain(1)[0], payload: { y: { a: 2, b: 1 }, x: 1 } });
    expect(a).toBe(b);
  });

  it('an untouched chain verifies and reports its head', () => {
    const rows = makeChain(25);
    const res = verifyChain(rows);
    expect(res.ok).toBe(true);
    expect(res.count).toBe(25);
    expect(res.head).toBe(rows[24].event_hash);
  });

  it('an empty chain verifies with the genesis head', () => {
    expect(verifyChain([])).toMatchObject({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it('AT1.9: editing the hashed text is detected at the edited row', () => {
    const rows = makeChain(10);
    rows[4] = { ...rows[4], canonical: rows[4].canonical.replace('field_filled', 'recipient_signed') };
    const res = verifyChain(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(5);
    expect(res.reason).toMatch(/hash/i);
  });

  it('editing a column but not the hashed text is detected (row disagrees with what was hashed)', () => {
    const rows = makeChain(10);
    rows[6] = { ...rows[6], ip: '198.51.100.9' };
    const res = verifyChain(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(7);
    expect(res.reason).toMatch(/column/i);
  });

  it('a consistent rewrite of one event (new text + new hash) breaks the next link', () => {
    const rows = makeChain(10);
    const forgedCanonical = buildCanonical({ ...rows[2], event_type: 'consent_given' });
    rows[2] = { ...rows[2], event_type: 'consent_given', canonical: forgedCanonical, event_hash: hashEvent(rows[2].prev_hash, forgedCanonical) };
    const res = verifyChain(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(4);
    expect(res.reason).toMatch(/prev/i);
  });

  it('deleting a middle row is detected', () => {
    const rows = makeChain(10);
    rows.splice(5, 1);
    const res = verifyChain(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(7);
    expect(res.reason).toMatch(/sequence/i);
  });

  it('reordering is detected', () => {
    const rows = makeChain(6);
    [rows[2], rows[3]] = [rows[3], rows[2]];
    expect(verifyChain(rows).ok).toBe(false);
  });

  it('tail truncation is detected against a stored checkpoint', () => {
    const rows = makeChain(10);
    const checkpoint = { seq: 10, hash: rows[9].event_hash };
    const truncated = rows.slice(0, 8);
    expect(verifyChain(truncated).ok).toBe(true); // internally consistent...
    const res = verifyChain(truncated, { checkpoint });
    expect(res.ok).toBe(false); // ...but shorter than the checkpoint
    expect(res.reason).toMatch(/checkpoint/i);
  });

  it('a checkpoint in the middle of a longer chain verifies (events continue after sealing)', () => {
    const rows = makeChain(12);
    expect(verifyChain(rows, { checkpoint: { seq: 7, hash: rows[6].event_hash } }).ok).toBe(true);
    expect(verifyChain(rows, { checkpoint: { seq: 7, hash: rows[7].event_hash } }).ok).toBe(false);
  });

  it('rows from two chains mixed together are rejected', () => {
    const rows = [...makeChain(2), ...makeChain(1, 'env:33333333-3333-4333-8333-333333333333')];
    expect(verifyChain(rows).ok).toBe(false);
  });
});
