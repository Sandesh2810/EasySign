// AT3.5 against the RUNNING app: one rate-limit test per endpoint in the brief's <signer_security> list.
// Run: start the app, then  npm run test:api
// Each test uses its own made-up caller address (X-Forwarded-For), so it never uses up anyone else's allowance.
// Most tests fill the limit through the same database counter the app uses (public.rate_limit_hit, keyed exactly
// as the app keys it) and then make ONE real request, which must be refused; "open a link" is also driven for
// real 31 times. Nothing is created: sign-up and sign-in never reach Supabase Auth once limited.
// Covered elsewhere (same AT): wrong access codes lock a link after 5 (signer-gate.test.ts); emailed codes are
// limited to one a minute and 5 an hour (signer-gate.test.ts, SQL); the /verify page after 20 (verify-page.test.ts).
// PowerForms arrive in Phase 4 and get their test then.
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const TOO_MANY = 'Too many attempts. Wait a few minutes and try again.';
let db: SupabaseClient;

const caller = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomBytes(4).toString('hex')}`;

/** Uses up `n` requests of a limit exactly as the app would count them. */
async function fill(bucket: string, key: string, limit: number, windowSeconds: number, n = limit) {
  for (let i = 0; i < n; i++) {
    const { data, error } = await db.rpc('rate_limit_hit', { p_bucket: bucket, p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
    if (error || data !== true) throw new Error(`could not fill ${bucket}: ${error?.message ?? data}`);
  }
}

const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Submits a page's form the way a browser without JavaScript does (Next.js server action form post). */
async function submitForm(path: string, fields: Record<string, string>, ip: string): Promise<string> {
  const page = await fetch(`${APP}${path}`, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.text());
  const form = /<form[\s\S]*?<\/form>/.exec(page)?.[0] ?? '';
  const body = new FormData();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g)) body.append(m[1], unescapeHtml(m[2] ?? ''));
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(`${APP}${path}`, { method: 'POST', body, headers: { 'X-Forwarded-For': ip }, redirect: 'manual' });
  return res.text();
}

const post = (path: string, json: unknown, ip: string) =>
  fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP, 'X-Forwarded-For': ip }, body: JSON.stringify(json) });

beforeAll(async () => {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SECRET) throw new Error('Settings are missing. Run "npm run setup:env".');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first, then run this again.`);
  db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
});

describe('AT3.5 rate limits, one per endpoint', () => {
  it('opening a signing link: 30 per network per 15 minutes; the 31st is refused, another network is not', async () => {
    const ip = caller();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await post('/api/sign/open', { token: randomBytes(32).toString('base64url') }, ip)).status);
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await post('/api/sign/open', { token: randomBytes(32).toString('base64url') }, caller())).status).not.toBe(429);
  }, 120_000);

  it('access codes and emailed codes: 40 checks per network per 15 minutes (on top of the 5-wrong-codes lock)', async () => {
    const ip = caller();
    await fill('sign_gate_ip', ip, 40, 900);
    const res = await post('/api/sign/gate', { action: 'access_code', code: '123456' }, ip);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe(TOO_MANY);
  });

  it('"Report this document": 10 per network per hour', async () => {
    const ip = caller();
    await fill('sign_report_ip', ip, 10, 3600);
    expect((await post('/api/sign/report', { reason: 'test' }, ip)).status).toBe(429);
  });

  it('sign-in: 30 per network per 15 minutes', async () => {
    const ip = caller();
    await fill('signin_ip', ip, 30, 900);
    const html = await submitForm('/login', { email: `rl-${randomBytes(4).toString('hex')}@example.test`, password: 'not-the-password-1' }, ip);
    expect(html).toContain(TOO_MANY);
  });

  it('sign-in: 10 tries per account per network per 15 minutes, while other accounts from the same network still get through', async () => {
    const ip = caller();
    const email = `rl-${randomBytes(4).toString('hex')}@example.test`;
    await fill('signin_account', `${email}|${ip}`, 10, 900);
    expect(await submitForm('/login', { email, password: 'not-the-password-1' }, ip)).toContain(TOO_MANY);
    const other = await submitForm('/login', { email: `rl-other-${randomBytes(4).toString('hex')}@example.test`, password: 'not-the-password-1' }, ip);
    expect(other).not.toContain(TOO_MANY);
    expect(other).toContain('That email and password do not match');
  });

  it('sign-up: 5 per network per hour and 3 per email address per hour', async () => {
    const ip = caller();
    await fill('signup_ip', ip, 5, 3600);
    const fields = { name: 'Rate Limit', email: `rl-${randomBytes(4).toString('hex')}@example.test`, password: `Pw-${randomBytes(12).toString('base64url')}` };
    expect(await submitForm('/signup', fields, ip)).toContain(TOO_MANY);

    const email = `rl-${randomBytes(4).toString('hex')}@example.test`;
    await fill('signup_email', email, 3, 3600);
    expect(await submitForm('/signup', { ...fields, email }, caller())).toContain(TOO_MANY);
  });

  it('confirming an email address: 20 per network per 15 minutes', async () => {
    const ip = caller();
    await fill('confirm_ip', ip, 20, 900);
    const html = await submitForm(`/auth/confirm?token_hash=${randomBytes(16).toString('hex')}&type=signup`, {}, ip);
    expect(html).toContain(TOO_MANY);
  });
});
