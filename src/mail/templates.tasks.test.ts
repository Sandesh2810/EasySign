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
