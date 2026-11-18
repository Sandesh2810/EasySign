import { describe, it, expect } from 'vitest';
import { completionTemplate, declinedTemplate, signatureRequestTemplate, voidedTemplate } from './templates';

const LINK = 'http://localhost:3000/s#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('signing email templates', () => {
  it('the request carries the signing link in the HTML and the plain-text part, and nothing else is clickable', () => {
    const t = signatureRequestTemplate({ signerName: 'Sam', senderName: 'Alice', title: 'NDA', signUrl: LINK, expiresOn: '2026-12-18' });
    expect(t.html).toContain(`href="${LINK}"`);
    expect(t.text).toContain(LINK);
    expect(t.html.match(/href="/g)).toHaveLength(1);
    expect(t.html).not.toMatch(/<img|<script|<link|<iframe/i);
  });

  it('escapes the title and the names', () => {
    const t = signatureRequestTemplate({ signerName: '<b>Sam</b>', senderName: '<i>Alice</i>', title: '<script>x</script>', signUrl: LINK, expiresOn: '2026-12-18' });
    expect(t.html).not.toContain('<script>x');
    expect(t.html).not.toContain('<b>Sam');
    expect(t.html).not.toContain('<i>Alice');
  });

  it('a title or name with line breaks cannot add lines to the subject', () => {
    const request = signatureRequestTemplate({ signerName: 'Sam', senderName: 'Alice\r\nBcc: someone@example.test', title: 'NDA\nX-Header: 1', signUrl: LINK, expiresOn: '2026-12-18' });
    const done = completionTemplate({ name: 'Sam', title: 'NDA\r\nBcc: someone@example.test', code: 'ES-2611-AAAA-BBBB-CCCC-DD', finalSha256: 'ab'.repeat(32) });
    for (const subject of [request.subject, done.subject]) {
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject.length).toBeLessThanOrEqual(200);
    }
  });

  it('the completion email has no signing link and shows the code and the hash', () => {
    const t = completionTemplate({ name: 'Sam', title: 'NDA', code: 'ES-2611-AAAA-BBBB-CCCC-DD', finalSha256: 'ab'.repeat(32) });
    expect(t.html).not.toContain('/s#');
    expect(t.text).toContain('ES-2611-AAAA-BBBB-CCCC-DD');
    expect(t.text).toContain('ab'.repeat(32));
  });

  it('approvers and viewers get their own wording, with the same single link', () => {
    const approve = signatureRequestTemplate({ signerName: 'Boss', senderName: 'Alice', title: 'NDA', signUrl: LINK, expiresOn: '2026-12-18', purpose: 'approve' });
    expect(approve.subject).toBe('Alice sent you "NDA" to approve');
    expect(approve.html).toContain('Review and approve');
    expect(approve.html).not.toContain('to review and sign');
    const view = signatureRequestTemplate({ signerName: 'Vera', senderName: 'Alice', title: 'NDA', signUrl: LINK, expiresOn: '2026-12-18', purpose: 'view' });
    expect(view.subject).toBe('Alice sent you "NDA" to read');
    expect(view.text).toContain('Nothing is needed from you');
    for (const t of [approve, view]) {
      expect(t.html.match(/href="/g)).toHaveLength(1);
      expect(t.text).toContain(LINK);
    }
  });

  it('the cancellation notice carries no link at all and escapes names', () => {
    const t = voidedTemplate({ name: '<b>Sam</b>', senderName: '<i>Alice</i>', title: 'NDA' });
    expect(t.subject).toBe('Cancelled: "NDA"');
    expect(t.html).not.toMatch(/href="/);
    expect(t.html).not.toContain('<b>Sam');
    expect(t.html).not.toContain('<i>Alice');
    expect(t.text).toContain('no longer works');
    expect(t.text).toContain('never completed');
  });

  it('the decline notice escapes the reason, carries no signing link, and says the document stopped', () => {
    const t = declinedTemplate({ name: 'Alice', title: 'NDA', declinedBy: '<b>Sam</b>', reason: '<img src=x onerror=alert(1)> too expensive', openUrl: 'http://localhost:3000/app/envelopes/abc' });
    expect(t.subject).toBe('Declined: "NDA"');
    expect(t.html).not.toContain('<img src=x');
    expect(t.html).not.toContain('<b>Sam');
    expect(t.html).not.toContain('/s#');
    expect(t.text).toContain('too expensive');
    expect(t.text).toContain('stopped for everyone');
    expect(declinedTemplate({ name: 'Alice', title: 'NDA', declinedBy: 'Sam', reason: null, openUrl: 'http://localhost:3000/x' }).text).toContain('did not give a reason');
  });
});
