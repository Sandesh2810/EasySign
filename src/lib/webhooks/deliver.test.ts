// D-92: a real POST to a receiver on this computer (allowed only with the development allowance), the signature it
// receives, and the refusals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { postWebhook } from './deliver';
import { newWebhookSecret, signatureHeader, verifyWebhook } from './signature';

let server: http.Server;
let base = '';
const got: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body, path: req.url ?? '' });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
      } else if (req.url === '/fail') {
        res.writeHead(503).end('down');
      } else if (req.url === '/slow') {
        setTimeout(() => res.writeHead(200).end(), 1500);
      } else if (req.url === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(100_000));
      } else res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('posting a webhook', () => {
  it('posts the exact body with headers the receiver can verify', async () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify({ type: 'webhook.test', timestamp: new Date().toISOString(), data: { message: 'hi' } });
    const ts = Math.floor(Date.now() / 1000);
    const id = '0f3b8a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    const r = await postWebhook(`${base}/hook`, body, { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signatureHeader([secret], id, ts, body) }, { allowLoopback: true });
    expect(r).toMatchObject({ ok: true, statusCode: 204, error: null });
    const last = got.at(-1)!;
    expect(last.body).toBe(body);
    expect(verifyWebhook(secret, { id: String(last.headers['webhook-id']), timestamp: String(last.headers['webhook-timestamp']), signature: String(last.headers['webhook-signature']) }, last.body)).toBe(true);
  });

  it('reports failures, does not follow redirects, stops slow receivers, and caps what it reads', async () => {
    expect(await postWebhook(`${base}/fail`, '{}', {}, { allowLoopback: true })).toMatchObject({ ok: false, statusCode: 503, error: 'HTTP 503' });
    const before = got.length;
    const redirect = await postWebhook(`${base}/redirect`, '{}', {}, { allowLoopback: true });
    expect(redirect).toMatchObject({ ok: false, statusCode: 302 });
    expect(redirect.error).toContain('Redirects are not followed');
    expect(got.length).toBe(before + 1);
    const slow = await postWebhook(`${base}/slow`, '{}', {}, { allowLoopback: true, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, statusCode: null, error: 'No answer within 10 seconds' });
    expect((await postWebhook(`${base}/big`, '{}', {}, { allowLoopback: true })).ok).toBe(true);
  });

  it('without the development allowance, this computer and private networks are refused before any connection', async () => {
    const before = got.length;
    const r = await postWebhook(`${base}/hook`, '{}', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Not sent: /);
    expect((await postWebhook('https://169.254.169.254/latest/meta-data', '{}', {})).error).toMatch(/^Not sent: /);
    expect((await postWebhook('https://localhost/x', '{}', {})).error).toMatch(/^Not sent: /);
    expect(got.length).toBe(before);
  });

  it('a name that resolves to this computer is refused at connection time', async () => {
    // "localtest.me"-style names are not used: "localhost." with a trailing dot passes the name check but resolves to loopback
    const r = await postWebhook(`https://localhost./x`, '{}', {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Not sent: the name points to a private or reserved address');
  });
});
