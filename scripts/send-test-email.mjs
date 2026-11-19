// npm run email:test -- you@example.com
// Sends ONE plain test email through Resend, to an address that is listed in SANDBOX_RECIPIENTS.
// It refuses any other address, whatever NOTIFY_MODE says, so it cannot write to anyone else.
// Use it to check that the key and the domain work, and to read the email's headers (SPF, DKIM, DMARC).
// Prints no secrets. Works in cmd.exe.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const key = process.env.RESEND_API_KEY ?? '';
const from = process.env.MAIL_FROM ?? '';
const allowed = (process.env.SANDBOX_RECIPIENTS ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
const to = (process.argv[2] ?? '').trim().toLowerCase();

const stop = (msg) => {
  console.error(msg);
  process.exit(2);
};
if (!key.startsWith('re_')) stop('RESEND_API_KEY is not set. Double-click Enter-Email-Settings.cmd first.');
if (!from) stop('MAIL_FROM is not set. Double-click Enter-Email-Settings.cmd first.');
if (allowed.length === 0) stop('SANDBOX_RECIPIENTS is empty. Double-click Enter-Email-Settings.cmd and enter your own address.');
if (!to) stop(`Say where to send it, for example:  npm run email:test -- ${allowed[0]}`);
if (!allowed.includes(to)) stop(`Refused: ${to} is not in SANDBOX_RECIPIENTS. Only these addresses can receive a test: ${allowed.join(', ')}`);

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `test:${randomUUID()}` },
  body: JSON.stringify({
    from,
    to: [to],
    subject: 'EasySign test email',
    text: `This is a test from EasySign, sent ${new Date().toISOString()}.\n\nIf you can read this, sending works. To check that the domain is set up correctly, open this email's details ("Show original" in Gmail) and look for SPF, DKIM and DMARC: each should say PASS.`,
    html: `<p>This is a test from EasySign, sent ${new Date().toISOString()}.</p><p>If you can read this, sending works. To check that the domain is set up correctly, open this email's details (&ldquo;Show original&rdquo; in Gmail) and look for SPF, DKIM and DMARC: each should say PASS.</p>`,
  }),
}).catch(() => null);
if (!res) stop('Resend could not be reached. Check the internet connection and try again.');
const data = await res.json().catch(() => ({}));
if (res.ok && data.id) {
  console.log(`Sent. Resend message id: ${data.id}`);
  console.log(`Check the inbox of ${to} (and its spam folder).`);
  process.exit(0);
}
console.error(`Resend refused it (${res.status} ${data.name ?? ''}): ${data.message ?? 'no details'}`);
if (data.name === 'validation_error' && /verify a domain|testing emails/i.test(String(data.message))) {
  console.error('This usually means the domain is not verified yet in Resend, or MAIL_FROM uses a different domain.');
}
process.exit(1);
