import { describe, it, expect } from 'vitest';
import { MailQuotaError, type MailMessage } from './types';
import { checkFromAddress, MailRefusedError, MAX_ATTACHMENT_BASE64_BYTES, RESEND_ENDPOINT, ResendMailProvider } from './resend-provider';

const KEY = 're_test_' + 'x'.repeat(24);
const msg = (over: Partial<MailMessage> = {}): MailMessage => ({
  to: 'Signer@Example.test',
  kind: 'signature_request',
  subject: 'Alice sent you "NDA"\r\nBcc: evil@example.test',
  html: '<p>hi</p>',
  text: 'hi',
  idempotencyKey: 'request:abc:1',
  ...over,
});

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('Resend email provider', () => {
  it('sends one request with the key, the idempotency key, a one-line subject and base64 attachments', async () => {
    const f = fakeFetch(200, { id: 'msg_123' });
    const p = new ResendMailProvider({ apiKey: KEY, from: 'EasySign <notify@easysign.work.gd>', mode: 'live', fetchImpl: f.impl });
    const res = await p.send(msg({ replyTo: 'alice@example.test', attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: new Uint8Array([1, 2, 3]) }] }));
    expect(res.id).toBe('msg_123');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(RESEND_ENDPOINT);
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Idempotency-Key']).toBe('request:abc:1');
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body).toMatchObject({ from: 'EasySign <notify@easysign.work.gd>', to: ['signer@example.test'], reply_to: ['alice@example.test'], html: '<p>hi</p>', text: 'hi' });
    expect(body.subject).not.toMatch(/[\r\n]/);
    expect(body.attachments).toEqual([{ filename: 'a.pdf', content: 'AQID', content_type: 'application/pdf' }]);
  });

  it('sandbox mode sends only to the listed addresses; nothing else leaves the computer', async () => {
    const f = fakeFetch(200, { id: 'msg_1' });
    const p = new ResendMailProvider({ apiKey: KEY, from: 'notify@easysign.work.gd', mode: 'sandbox', allowed: [' Owner@Example.test '], fetchImpl: f.impl });
    await expect(p.send(msg())).rejects.toBeInstanceOf(MailRefusedError);
    expect(f.calls).toHaveLength(0);
    await expect(p.send(msg({ to: 'owner@example.test' }))).resolves.toEqual({ id: 'msg_1' });
    expect(f.calls).toHaveLength(1);
    expect(() => new ResendMailProvider({ apiKey: KEY, from: 'notify@easysign.work.gd', mode: 'sandbox', allowed: ['', ' '] })).toThrow(/SANDBOX_RECIPIENTS/);
  });

  it('turns the provider quota into "wait for the reset", and temporary trouble into "try again"', async () => {
    const make = (status: number, name: string) => new ResendMailProvider({ apiKey: KEY, from: 'notify@easysign.work.gd', mode: 'live', fetchImpl: fakeFetch(status, { name, message: 'x' }).impl });
    await expect(make(429, 'daily_quota_exceeded').send(msg())).rejects.toBeInstanceOf(MailQuotaError);
    await expect(make(429, 'monthly_quota_exceeded').send(msg())).rejects.toMatchObject({ scope: 'monthly' });
    for (const [status, name] of [[429, 'rate_limit_exceeded'], [409, 'concurrent_idempotent_requests'], [500, 'internal_server_error']] as const) {
      const e = await make(status, name).send(msg()).catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(MailRefusedError);
      expect(String(e.message)).toContain('try again later');
    }
    const refused = await make(422, 'validation_error').send(msg()).catch((x) => x);
    expect(refused).toBeInstanceOf(MailRefusedError);
    expect(String(refused.message)).not.toContain(KEY);
  });

  it('refuses attachments over the provider limit before sending', async () => {
    const f = fakeFetch(200, { id: 'x' });
    const p = new ResendMailProvider({ apiKey: KEY, from: 'notify@easysign.work.gd', mode: 'live', fetchImpl: f.impl });
    const big = new Uint8Array(Math.ceil((MAX_ATTACHMENT_BASE64_BYTES / 4) * 3) + 3);
    await expect(p.send(msg({ attachments: [{ filename: 'big.pdf', contentType: 'application/pdf', content: big }] }))).rejects.toBeInstanceOf(MailRefusedError);
    expect(f.calls).toHaveLength(0);
    // the largest possible EasySign completion (10 MB document + certificate) is far below the limit
    expect(Math.ceil((11 * 1024 * 1024) / 3) * 4).toBeLessThan(MAX_ATTACHMENT_BASE64_BYTES);
  });

  it('will not start with a missing or wrong key or a malformed sender address', () => {
    expect(() => new ResendMailProvider({ apiKey: '', from: 'notify@easysign.work.gd', mode: 'live' })).toThrow(/RESEND_API_KEY/);
    expect(() => new ResendMailProvider({ apiKey: 'sb_secret_xxx', from: 'notify@easysign.work.gd', mode: 'live' })).toThrow(/re_/);
    expect(() => new ResendMailProvider({ apiKey: KEY, from: 'not an address', mode: 'live' })).toThrow(/MAIL_FROM/);
    expect(checkFromAddress('EasySign <notify@easysign.work.gd>')).toBeNull();
    expect(checkFromAddress('notify@easysign.work.gd')).toBeNull();
    expect(checkFromAddress('EasySign <notify@easysign.work.gd>\r\nBcc: x@y.z')).not.toBeNull();
  });
});
