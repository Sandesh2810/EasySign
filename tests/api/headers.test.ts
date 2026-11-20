// AT3.5 against the RUNNING app: security headers, the nonce-based Content-Security-Policy (report-only) and the
// report endpoint. Run against a production build (npm run build, then npx next start) to see what users get.
// These tests never store a report, so they do not disturb the 48-hour "no reports" count (npm run csp:report).
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const caller = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomBytes(4).toString('hex')}`;

describe('AT3.5 headers and Content-Security-Policy', () => {
  for (const path of ['/login', '/signup', '/verify', '/sign', '/s']) {
    it(`${path}: a fresh nonce on every response, carried by every script; never framed`, async () => {
      const [a, b] = await Promise.all([fetch(`${APP}${path}`), fetch(`${APP}${path}`)]);
      const policy = a.headers.get('content-security-policy-report-only') ?? '';
      const nonce = /'nonce-([^']+)'/.exec(policy)?.[1] ?? '';
      expect(nonce.length).toBeGreaterThanOrEqual(16);
      expect(policy).toContain("'strict-dynamic'");
      expect(policy).toContain('report-uri /api/csp-report');
      expect(/'nonce-([^']+)'/.exec(b.headers.get('content-security-policy-report-only') ?? '')?.[1]).not.toBe(nonce);
      const html = await a.text();
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.filter((s) => !s.includes(`nonce="${nonce}"`))).toEqual([]);
      expect(a.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(a.headers.get('x-frame-options')).toBe('DENY');
      expect(a.headers.get('referrer-policy')).toBe('no-referrer');
      expect(a.headers.get('x-content-type-options')).toBe('nosniff');
    });
  }

  it('HSTS is only sent on https (this local run is http, so none)', async () => {
    const res = await fetch(`${APP}/login`);
    expect(res.headers.get('strict-transport-security')).toBe(APP.startsWith('https://') ? expect.stringMatching(/^max-age=\d+/) : null);
  });

  it('the report endpoint accepts browser reports, refuses junk and oversized bodies, and is rate limited', async () => {
    const ip = caller();
    const send = (body: string, type = 'application/csp-report') =>
      fetch(`${APP}/api/csp-report`, { method: 'POST', headers: { 'Content-Type': type, 'X-Forwarded-For': ip }, body });
    expect((await send('[]', 'application/reports+json')).status).toBe(204); // valid, nothing to store
    expect((await send('{not json')).status).toBe(400);
    expect((await send(JSON.stringify({ x: 'y'.repeat(20_000) }))).status).toBe(413);
    let limited = 0;
    for (let i = 0; i < 61; i++) if ((await send('[]', 'application/reports+json')).status === 429) limited += 1;
    expect(limited).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
