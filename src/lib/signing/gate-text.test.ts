import { describe, it, expect } from 'vitest';
import { otpTemplate } from '@/mail/templates';
import { generateOtp, hashOtp } from '@/lib/signer-token';
import { lockedMessage, triesLeft } from './gate-text';

const NOW = new Date('2026-11-18T12:00:00Z');
const KEY = Buffer.alloc(32, 7).toString('base64url');

describe('wording on the code screen', () => {
  it('says how long a lock lasts, in minutes or "about an hour"', () => {
    expect(lockedMessage('2026-11-18T12:14:30Z', NOW)).toContain('locked for 15 minutes');
    expect(lockedMessage('2026-11-18T12:00:20Z', NOW)).toContain('locked for 1 minute.');
    expect(lockedMessage('2026-11-18T12:59:00Z', NOW)).toContain('about an hour');
  });

  it('says to ask the sender when only the sender can unlock', () => {
    expect(lockedMessage('infinity', NOW)).toContain('Ask the person who sent you the document to unlock it');
    expect(lockedMessage(null, NOW)).toContain('Ask the person who sent you');
  });

  it('counts tries in plain words', () => {
    expect(triesLeft(1)).toBe('You have 1 try left.');
    expect(triesLeft(4)).toBe('You have 4 tries left.');
  });
});

describe('emailed code', () => {
  it('is six digits, and its stored form is a keyed hash bound to one person', () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
    const a = hashOtp('123456', 'person-a', KEY);
    expect(a.length).toBe(32);
    expect(a.equals(hashOtp('123456', 'person-a', KEY))).toBe(true);
    expect(a.equals(hashOtp('123456', 'person-b', KEY))).toBe(false); // the same code is a different hash for someone else
    expect(a.equals(hashOtp('123457', 'person-a', KEY))).toBe(false);
    expect(a.equals(hashOtp('123456', 'person-a', Buffer.alloc(32, 8).toString('base64url')))).toBe(false); // useless without the key
    expect(a.toString('hex')).not.toContain('123456');
  });

  it('the email shows the code, how long it works, and no link at all', () => {
    const mail = otpTemplate({ name: 'Rita <b>', title: 'Lease "2027"', code: '048213', minutes: 10 });
    expect(mail.subject).toBe('Your code to open "Lease "2027""');
    expect(mail.subject).not.toContain('048');
    expect(mail.html).toContain('048 213');
    expect(mail.text).toContain('048 213');
    expect(mail.text).toContain('works once and for 10 minutes');
    expect(mail.html).toContain('Hello Rita &lt;b&gt;,');
    expect(mail.html).not.toMatch(/href=/);
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.text).toContain('Never give this code to anyone');
  });
});
