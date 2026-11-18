import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogMailProvider } from './log-provider';
import type { MailMessage } from './types';

const msg = (over: Partial<MailMessage> = {}): MailMessage => ({
  to: 'sam.signer@example.test',
  kind: 'signature_request',
  subject: 'Sandra Sender sent you "NDA" to sign',
  html: '<p>Open <a href="http://localhost:3000/s#TOKEN123">the document</a></p>',
  text: 'Open http://localhost:3000/s#TOKEN123',
  idempotencyKey: 'env1:r1:request:1',
  ...over,
});

describe('LogMailProvider (NOTIFY_MODE=log)', () => {
  let dir: string;
  let mail: LogMailProvider;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'easysign-outbox-'));
    mail = new LogMailProvider(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the email to the dev outbox instead of sending it, with a working link inside', async () => {
    const r = await mail.send(msg());
    expect(r.id).toMatch(/^log-/);
    const files = readdirSync(dir).sort();
    expect(files.filter((f) => f.endsWith('.html'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    const html = readFileSync(path.join(dir, files.find((f) => f.endsWith('.html'))!), 'utf8');
    expect(html).toContain('http://localhost:3000/s#TOKEN123');
    const meta = JSON.parse(readFileSync(path.join(dir, files.find((f) => f.endsWith('.json'))!), 'utf8'));
    expect(meta).toMatchObject({ to: 'sam.signer@example.test', subject: 'Sandra Sender sent you "NDA" to sign', kind: 'signature_request', mode: 'log' });
    expect(meta.text).toContain('/s#TOKEN123');
  });

  it('the same idempotency key never produces a second email', async () => {
    const a = await mail.send(msg());
    const b = await mail.send(msg());
    expect(b.id).toBe(a.id);
    expect(readdirSync(dir).filter((f) => f.endsWith('.html'))).toHaveLength(1);
  });

  it('different keys produce separate emails, and file names cannot escape the outbox', async () => {
    await mail.send(msg({ idempotencyKey: 'k1', to: '../../evil@example.test', kind: '../x' }));
    await mail.send(msg({ idempotencyKey: 'k2' }));
    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith('.html'))).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/^[A-Za-z0-9._@-]+$/);
  });

  it('records attachments by name and size without bloating the outbox entry', async () => {
    await mail.send(msg({ idempotencyKey: 'k3', attachments: [{ filename: 'sealed.pdf', contentType: 'application/pdf', content: new Uint8Array(1234) }] }));
    const meta = JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))!), 'utf8'));
    expect(meta.attachments).toEqual([{ filename: 'sealed.pdf', contentType: 'application/pdf', bytes: 1234 }]);
  });

  it('refuses a message with no recipient or an obviously invalid address', async () => {
    await expect(mail.send(msg({ to: '' }))).rejects.toThrow();
    await expect(mail.send(msg({ to: 'not-an-email' }))).rejects.toThrow();
  });
});
