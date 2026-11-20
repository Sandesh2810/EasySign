import { describe, it, expect } from 'vitest';
import { describeNotification } from './notifications';
import { digestTemplate } from '@/mail/templates';

const ID = '1ba7ce9b-b149-4603-ab9d-28e8caa14fcb';

describe('in-app notices', () => {
  it('says who did what to which document, and links to it', () => {
    const v = describeNotification('recipient_signed', { envelope_id: ID, title: 'Lease 2027', by: 'Rita Reyes' });
    expect(v).toEqual({ text: 'Rita Reyes signed "Lease 2027".', path: `/app/envelopes/${ID}`, tone: 'good' });
    expect(describeNotification('recipient_approved', { envelope_id: ID, title: 'Lease 2027', by: 'Bo' }).text).toBe('Bo approved "Lease 2027".');
  });

  it('every kind the database writes has its own wording', () => {
    const kinds = [
      'recipient_signed',
      'recipient_approved',
      'envelope_completed',
      'envelope_declined',
      'envelope_expired',
      'consent_withdrawn',
      'paper_copy_requested',
      'mfa_reset',
      'sealing_failed',
      'email_failed',
      'email_deferred',
      'signer_locked',
      'abuse_report',
      'account_suspended',
      'account_suspension_lifted',
      'account_approved',
      'account_approval_removed',
    ];
    const fallback = describeNotification('something_new', {}).text;
    const texts = kinds.map((k) => describeNotification(k, { envelope_id: ID, title: 'T', by: 'B', kind: 'signature_request' }).text);
    expect(new Set(texts).size).toBe(kinds.length);
    for (const t of texts) expect(t).not.toBe(fallback);
  });

  it('a held email tells the sender what waits, until when, and what they can do now', () => {
    const v = describeNotification('email_deferred', { envelope_id: ID, title: 'NDA', kind: 'signature_request' });
    expect(v.text).toContain('the request to sign for "NDA"');
    expect(v.text).toContain('after the daily reset');
    expect(v.text).toContain('copy the link');
    expect(v.tone).toBe('attention');
  });

  it('a locked link tells the sender whether they have to do something', () => {
    const timed = describeNotification('signer_locked', { envelope_id: ID, title: 'NDA', by: 'Rita', needs_sender: false });
    const stuck = describeNotification('signer_locked', { envelope_id: ID, title: 'NDA', by: 'Rita', needs_sender: true });
    expect(timed.text).toContain('Rita entered the wrong code too many times for "NDA"');
    expect(timed.text).toContain('works again');
    expect(stuck.text).toContain('until you unlock it');
    expect(stuck.path).toBe(`/app/envelopes/${ID}`);
    // only a real "true" from the database counts
    expect(describeNotification('signer_locked', { title: 'NDA', by: 'Rita', needs_sender: 'true' }).text).toContain('works again');
  });

  it('never builds a link from something that is not a document id', () => {
    for (const bad of ['../admin', 'javascript:alert(1)', '', 42, null, `${ID}/../../x`]) {
      expect(describeNotification('envelope_completed', { envelope_id: bad, title: 'T' }).path).toBeNull();
    }
    expect(describeNotification('account_approved', { envelope_id: ID }).path).toBeNull();
  });

  it('copes with missing or odd stored values', () => {
    expect(describeNotification('recipient_signed', null).text).toBe('Someone signed a document.');
    expect(describeNotification('recipient_signed', { title: 'A\nB\u0000C', by: 7 }).text).toBe('Someone signed "A B C".');
    expect(describeNotification('email_failed', { kind: 'made_up' }).text).toContain('(an email)');
    expect(describeNotification('recipient_signed', { title: 'x'.repeat(500), by: 'y'.repeat(500) }).text.length).toBeLessThan(360);
  });
});

describe('daily summary email', () => {
  const lines = ['Rita signed "Lease".', '<img src=x onerror=alert(1)> approved "A & B".'];

  it('lists the notices, escaped, with a count in the subject', () => {
    const mail = digestTemplate({ name: 'Sam <b>', lines, more: 0, openUrl: 'http://localhost:3000/app/notifications' });
    expect(mail.subject).toBe('YouNMeSign: 2 updates on your documents');
    expect(mail.html).toContain('Rita signed &quot;Lease&quot;.');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt; approved &quot;A &amp; B&quot;.');
    expect(mail.html).toContain('Hello Sam &lt;b&gt;,');
    expect(mail.text).toContain('- Rita signed "Lease".');
    expect(mail.text).toContain('http://localhost:3000/app/notifications');
    expect(mail.text).toContain('switch it off');
  });

  it('says so when there are more than fit, and uses the singular for one', () => {
    const many = digestTemplate({ name: 'Sam', lines, more: 5, openUrl: 'http://x.test/app/notifications' });
    expect(many.subject).toBe('YouNMeSign: 7 updates on your documents');
    expect(many.text).toContain('And 5 more.');
    expect(digestTemplate({ name: 'Sam', lines: ['One.'], more: 0, openUrl: 'http://x.test' }).subject).toBe('YouNMeSign: 1 update on your documents');
  });
});
