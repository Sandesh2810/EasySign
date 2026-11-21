import { describe, expect, it } from 'vitest';
import { senderTaskTemplate } from './templates';

describe('sender task emails (AT3.3)', () => {
  it('paper copy: names the signer, carries the note escaped, links to the document', () => {
    const m = senderTaskTemplate({ name: 'Sam', title: 'Lease <1>', by: 'Paula', kind: 'paper_copy', note: 'Post to <b>office</b>', openUrl: 'https://x.test/app/envelopes/1' });
    expect(m.subject).toBe('Paper copy requested: "Lease <1>"');
    expect(m.html).toContain('Post to &lt;b&gt;office&lt;/b&gt;');
    expect(m.html).not.toContain('<b>office');
    expect(m.text).toContain('https://x.test/app/envelopes/1');
  });
  it('withdrawal: says what was cleared and what the sender can do; no note line without a reason', () => {
    const m = senderTaskTemplate({ name: 'Sam', title: 'Lease', by: 'Paula', kind: 'consent_withdrawn', note: null, openUrl: 'https://x.test/a' });
    expect(m.subject).toBe('Consent withdrawn: "Lease"');
    expect(m.text).toContain('cannot sign until they agree again');
    expect(m.text).not.toContain('Their reason');
  });
});

describe('answer emails (D-84)', () => {
  it("carries the sender's answer escaped, one-line subject, the person's link and its end date", async () => {
    const { commentReplyTemplate } = await import('./templates');
    const m = commentReplyTemplate({ name: 'Ann', senderName: 'Sam\nSender', title: 'Lease <1>', answer: 'Yes, <b>within</b> 10%.\nSee clause 4.', signUrl: 'https://x.test/s#tok', expiresOn: '2026-12-31' });
    expect(m.subject).toBe('Sam Sender answered your question about "Lease <1>"');
    expect(m.html).toContain('Yes, &lt;b&gt;within&lt;/b&gt; 10%.');
    expect(m.html).not.toContain('<b>within');
    expect(m.html).toContain('https://x.test/s#tok');
    expect(m.text).toContain('Yes, <b>within</b> 10%.\nSee clause 4.');
    expect(m.text).toContain('works until 2026-12-31');
  });
});
