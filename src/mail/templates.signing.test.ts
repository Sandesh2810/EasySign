import { describe, it, expect } from 'vitest';
import { completionTemplate, signatureRequestTemplate } from './templates';

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
});
