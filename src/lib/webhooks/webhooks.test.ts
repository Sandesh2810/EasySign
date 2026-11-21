// D-92 (AT5.2): signatures, replay window, the stored-secret box and the address guard.
import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { newWebhookSecret, secretBytes, signature, signatureHeader, verifyWebhook } from './signature';
import { openSecret, sealSecret } from './secret-box';
import { checkWebhookUrl, isAllowedAddress, loopbackAllowed } from './url-guard';
import { MAX_ATTEMPTS, RETRY_DELAYS_SECONDS } from './events';

describe('signatures (Standard Webhooks v1)', () => {
  // the worked example from the Standard Webhooks reference test suite (libraries/javascript)
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const ts = 1614265330;
  const body = '{"test": 2432232314}';

  it('matches the reference signature', () => {
    expect(signature(secret, id, ts, body)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('is HMAC-SHA256 over "id.timestamp.body" with the decoded secret', () => {
    const s = newWebhookSecret();
    const mac = createHmac('sha256', Buffer.from(s.slice(6), 'base64')).update(`abc.${ts}.${body}`).digest('base64');
    expect(signature(s, 'abc', ts, body)).toBe(`v1,${mac}`);
  });

  it('new secrets are whsec_ + 32 random bytes and all different', () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(secretBytes(a)).toHaveLength(32);
    expect(newWebhookSecret()).not.toBe(a);
    expect(() => secretBytes('whsec_short')).toThrow();
    expect(() => secretBytes('sk_' + 'a'.repeat(40))).toThrow();
  });

  it('verifies, and refuses a changed body, id, timestamp or secret', () => {
    const s = newWebhookSecret();
    const now = 1_800_000_000;
    const h = { id: 'abc', timestamp: String(now), signature: signature(s, 'abc', now, body) };
    expect(verifyWebhook(s, h, body, now)).toBe(true);
    expect(verifyWebhook(s, h, body + ' ', now)).toBe(false);
    expect(verifyWebhook(s, { ...h, id: 'abd' }, body, now)).toBe(false);
    expect(verifyWebhook(s, { ...h, timestamp: String(now - 1) }, body, now)).toBe(false);
    expect(verifyWebhook(newWebhookSecret(), h, body, now)).toBe(false);
    expect(verifyWebhook(s, { ...h, signature: 'v1a,' + h.signature.slice(3) }, body, now)).toBe(false);
    expect(verifyWebhook(s, { ...h, signature: null }, body, now)).toBe(false);
  });

  it('replay protection: refuses a timestamp more than 5 minutes away', () => {
    const s = newWebhookSecret();
    const then = 1_800_000_000;
    const h = { id: 'abc', timestamp: String(then), signature: signature(s, 'abc', then, body) };
    expect(verifyWebhook(s, h, body, then + 300)).toBe(true);
    expect(verifyWebhook(s, h, body, then + 301)).toBe(false);
    expect(verifyWebhook(s, h, body, then - 301)).toBe(false);
  });

  it('during a secret change both secrets sign, and either verifies', () => {
    const [oldS, newS] = [newWebhookSecret(), newWebhookSecret()];
    const header = signatureHeader([newS, oldS], 'abc', ts, body);
    expect(header.split(' ')).toHaveLength(2);
    expect(verifyWebhook(oldS, { id: 'abc', timestamp: String(ts), signature: header }, body, ts)).toBe(true);
    expect(verifyWebhook(newS, { id: 'abc', timestamp: String(ts), signature: header }, body, ts)).toBe(true);
  });

  it('refuses ids that could break the signed content', () => {
    expect(() => signature(newWebhookSecret(), 'a.b', ts, body)).toThrow();
  });
});

describe('stored secrets are encrypted and bound to their endpoint', () => {
  const key = randomBytes(32).toString('base64url');
  const s = newWebhookSecret();
  it('round-trips, and differs every time', () => {
    const boxed = sealSecret(s, 'endpoint-1', key);
    expect(boxed).not.toContain(s.slice(6, 20));
    expect(openSecret(boxed, 'endpoint-1', key)).toBe(s);
    expect(sealSecret(s, 'endpoint-1', key)).not.toBe(boxed);
  });
  it('cannot be opened for another endpoint, with another key, or after a change', () => {
    const boxed = sealSecret(s, 'endpoint-1', key);
    expect(() => openSecret(boxed, 'endpoint-2', key)).toThrow();
    expect(() => openSecret(boxed, 'endpoint-1', randomBytes(32).toString('base64url'))).toThrow();
    const flipped = boxed.slice(0, -2) + (boxed.at(-2) === 'A' ? 'B' : 'A') + boxed.at(-1);
    expect(() => openSecret(flipped, 'endpoint-1', key)).toThrow();
  });
});

describe('where events may be sent (no SSRF)', () => {
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) expect(isAllowedAddress(ip), ip).toBe(true);
  });
  it('refuses loopback, private, link-local, CGNAT, multicast, reserved and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '192.0.2.1', '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2001:db8::1', '2002:7f00:1::1', '2001::1', 'not-an-ip',
    ]) expect(isAllowedAddress(ip), ip).toBe(false);
  });
  it('checks typed addresses', () => {
    expect(checkWebhookUrl('https://hooks.example.com/ynms').ok).toBe(true);
    expect(checkWebhookUrl('https://8.8.8.8:8443/x').ok).toBe(true);
    for (const [url, why] of [
      ['http://hooks.example.com/x', 'https'],
      ['ftp://hooks.example.com/x', 'https'],
      ['https://user:pw@hooks.example.com/x', 'password'],
      ['https://hooks.example.com/x#frag', '#'],
      ['https://localhost/x', 'private network'],
      ['https://printer.local/x', 'private network'],
      ['https://intranet/x', 'private network'],
      ['https://metadata.google.internal/x', 'private network'],
      ['https://127.0.0.1/x', 'private'],
      ['https://169.254.169.254/latest/meta-data', 'private'],
      ['https://[::1]/x', 'private'],
      ['https://[::ffff:10.0.0.1]/x', 'private'],
      ['https://2130706433/x', 'private'],
      ['https://0x7f.1/x', 'private'],
      ['not a url', 'web address'],
      ['', 'Enter'],
    ] as const) {
      const r = checkWebhookUrl(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason, url).toContain(why);
    }
  });
  it('the development allowance covers only this computer, and only on a local app', () => {
    expect(checkWebhookUrl('http://127.0.0.1:4555/hook', { allowLoopback: true }).ok).toBe(true);
    expect(checkWebhookUrl('http://localhost:4555/hook', { allowLoopback: true }).ok).toBe(true);
    expect(checkWebhookUrl('http://10.0.0.5/hook', { allowLoopback: true }).ok).toBe(false);
    expect(checkWebhookUrl('http://hooks.example.com/hook', { allowLoopback: true }).ok).toBe(false);
    expect(isAllowedAddress('127.0.0.1', { allowLoopback: true })).toBe(true);
    expect(isAllowedAddress('192.168.0.1', { allowLoopback: true })).toBe(false);
    expect(loopbackAllowed({ WEBHOOK_ALLOW_LOOPBACK: '1', APP_URL: 'http://localhost:3000' })).toBe(true);
    expect(loopbackAllowed({ WEBHOOK_ALLOW_LOOPBACK: '1' })).toBe(true);
    expect(loopbackAllowed({ WEBHOOK_ALLOW_LOOPBACK: '1', APP_URL: 'https://younmesign.com' })).toBe(false);
    expect(loopbackAllowed({ WEBHOOK_ALLOW_LOOPBACK: '1', APP_URL: 'http://localhost:3000', NODE_ENV: 'production' })).toBe(false);
    expect(loopbackAllowed({ APP_URL: 'http://localhost:3000' })).toBe(false);
  });
});

describe('retry rule', () => {
  it('seven attempts over about 21 hours', () => {
    expect(MAX_ATTEMPTS).toBe(7);
    expect(RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0)).toBe(74160);
  });
});
