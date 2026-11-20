import { describe, expect, it } from 'vitest';
import { buildCsp, CSP_REPORT_PATH, newNonce, parseCspReports } from './csp';
import { authCookieOptions } from './supabase/cookie-options';

describe('Content-Security-Policy (AT3.5)', () => {
  it('scripts only from this site with the response nonce; no eval in production; never framed; reports to us', () => {
    const p = buildCsp({ nonce: 'abc123==', dev: false, https: true });
    expect(p).toContain("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(p).not.toContain('unsafe-eval');
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(p).toContain('upgrade-insecure-requests');
    expect(p).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('development adds eval for React debugging and skips the https upgrade', () => {
    const p = buildCsp({ nonce: 'n', dev: true, https: false });
    expect(p).toContain("'unsafe-eval'");
    expect(p).not.toContain('upgrade-insecure-requests');
  });

  it('a fresh 128-bit nonce each time', () => {
    const a = newNonce();
    expect(atob(a)).toHaveLength(16);
    expect(newNonce()).not.toBe(a);
  });

  it('reads both report formats and keeps only the directive, the blocked origin and the page path', () => {
    const old = parseCspReports({
      'csp-report': { 'violated-directive': 'script-src-elem', 'blocked-uri': 'https://evil.test/x.js?secret=1', 'document-uri': 'http://localhost:3000/sign?x=1', 'script-sample': 'alert(1)' },
    });
    expect(old).toEqual([{ directive: 'script-src-elem', blocked: 'https://evil.test', documentPath: '/sign', sample: 'alert(1)' }]);
    const modern = parseCspReports([
      { type: 'csp-violation', body: { effectiveDirective: 'style-src-elem', blockedURL: 'inline', documentURL: 'http://localhost:3000/app' } },
      { type: 'deprecation', body: {} },
    ]);
    expect(modern).toEqual([{ directive: 'style-src-elem', blocked: 'inline', documentPath: '/app', sample: '' }]);
    expect(parseCspReports('nonsense')).toEqual([]);
    // a browser extension's own scripts are not the app's problem
    expect(parseCspReports({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'eval', 'source-file': 'chrome-extension://abcdef/content.js' } })).toEqual([]);
    expect(parseCspReports([{ type: 'csp-violation', body: { effectiveDirective: 'script-src-elem', blockedURL: 'moz-extension://x/inject.js' } }])).toEqual([]);
    expect(parseCspReports(Array.from({ length: 50 }, () => ({ type: 'csp-violation', body: { effectiveDirective: 'img-src' } })))).toHaveLength(10);
  });
});

describe('account session cookie (D-50, D-70)', () => {
  it('on https it is a __Host- cookie: secure, whole site, no domain, not readable by scripts', () => {
    const o = authCookieOptions('https://younmesign.com');
    expect(o).toEqual({ name: '__Host-ys-auth', path: '/', sameSite: 'lax', secure: true, httpOnly: true });
    expect(o).not.toHaveProperty('domain');
  });
  it('on plain-http development it keeps the default name (browsers refuse __Host- without https)', () => {
    const o = authCookieOptions('http://localhost:3000');
    expect(o).not.toHaveProperty('name');
    expect(o.secure).toBe(false);
    expect(o.httpOnly).toBe(true);
  });
});
