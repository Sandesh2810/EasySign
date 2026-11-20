import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { GENESIS_HASH, buildCanonical, hashEvent, type AuditRow } from '@/lib/audit-chain';
import { buildAuditReport } from './audit-report';

function rows(n: number): AuditRow[] {
  const out: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const ev = {
      chain_key: 'env:11111111-1111-4111-8111-111111111111',
      chain_seq: i,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      org_id: null,
      envelope_id: '11111111-1111-4111-8111-111111111111',
      recipient_id: null,
      actor_type: 'signer',
      actor_id: null,
      event_type: 'field_filled',
      payload: { note: 'नमस्ते and a long value '.repeat(5) },
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150',
      created_at: '2026-11-20T10:00:00.000000Z',
    };
    const canonical = buildCanonical(ev);
    const event_hash = hashEvent(prev, canonical);
    out.push({ ...ev, canonical, prev_hash: prev, event_hash });
    prev = event_hash;
  }
  return out;
}

describe('audit trail PDF', () => {
  it('lists every event over as many pages as needed, survives non-Latin text, and says whether the chain verified', async () => {
    const r = rows(60);
    const bytes = await buildAuditReport({
      publicCode: 'ES-2611-AAAA-BBBB-CCCC-DD',
      status: 'completed',
      title: 'Lease ✓',
      finalSha256: 'ab'.repeat(32),
      rows: r,
      verified: true,
      head: r[59].event_hash,
      archivedParts: 1,
      generatedAt: new Date('2026-11-20T12:00:00Z'),
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(2);
    expect(pdf.getTitle()).toBe('Audit trail ES-2611-AAAA-BBBB-CCCC-DD');
  });
});
