import { describe, it, expect } from 'vitest';
import { buildTimeline } from './timeline';

describe('document history', () => {
  const names = new Map([['r1', 'Rita Reyes']]);
  const ev = (event_type: string, recipient_id: string | null = null) => ({ event_type, created_at: '2026-11-19T10:00:00Z', recipient_id });

  it('says each step in plain words and names the person it concerns', () => {
    const t = buildTimeline([ev('envelope_sent'), ev('link_opened', 'r1'), ev('recipient_signed', 'r1'), ev('envelope_completed'), ev('envelope_filed')], names);
    expect(t.map((x) => x.what)).toEqual(['Sent', 'Opened the link', 'Signed', 'Completed', 'Filed into a folder by a rule']);
    expect(t[1].who).toBe('Rita Reyes');
    expect(t[0].who).toBeNull();
  });

  it('names the public check and audit download steps (D-72)', () => {
    expect(buildTimeline([ev('verify_page_hit'), ev('audit_exported')], names).map((x) => x.what)).toEqual(['Looked up on the public check page', 'Audit trail downloaded']);
  });

  it('names the legal hold and deletion steps (AT3.6)', () => {
    const t = buildTimeline([ev('legal_hold_set'), ev('legal_hold_released'), ev('deletion_started'), ev('envelope_deleted')], names);
    expect(t.map((x) => x.what)).toEqual(['Put on legal hold', 'Legal hold released', 'Deletion started by the owner', 'Deleted by the owner (files, typed values, signatures and names removed)']);
  });

  it('names the consent and paper-copy steps (AT3.3)', () => {
    const t = buildTimeline([ev('consent_withdrawn', 'r1'), ev('paper_copy_requested', 'r1'), ev('sender_task_done', 'r1')], names);
    expect(t.map((x) => x.what)).toEqual(['Withdrew consent to sign electronically', 'Asked for a paper copy', 'Request marked as done']);
  });

  it('leaves out bookkeeping steps unless asked, and never shows a raw code for an unknown step', () => {
    expect(buildTimeline([ev('email_queued'), ev('fields_changed'), ev('email_sent')], names).map((x) => x.what)).toEqual(['Email sent']);
    expect(buildTimeline([ev('email_queued')], names, { all: true })).toHaveLength(1);
    expect(buildTimeline([ev('something_new_later')], names)[0].what).toBe('something new later');
    expect(buildTimeline([ev('recipient_signed', 'gone')], names)[0].who).toBe('A person who is no longer on the document');
  });
});
