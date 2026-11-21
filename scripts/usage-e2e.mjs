// npm run e2e:usage [-- --app http://localhost:3000]
// End-to-end check of usage metering and plan limits (Phase 5 slice 5, D-94), in its own synthetic workspace:
// API requests are counted exactly; Settings shows the plan and this month's usage, equal to the database's own
// summary; the API's limits come from the plan: a tight test plan (added for the run and removed afterwards, through
// the owner database connection, because the app itself cannot change plans) gives 429 after its per-minute limit and
// 429 "monthly_limit" with a Retry-After to the 1st once its monthly limit is used; back on Free, the key works again.
// Needs the app running. Signs in once.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-core';
import { dbClient } from './lib/db.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OWNER = { email: 'usage-owner@example.test', name: 'Ursa Usage' };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const TEST_PLAN = 'e2e_tight';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
const call = (key) => fetch(`${APP}/api/v1/templates`, { headers: { Authorization: `Bearer ${key}` } }).then(async (r) => ({ status: r.status, retry: r.headers.get('retry-after'), body: await r.json().catch(() => null) }));

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Usage and plan limits end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const owner = dbClient(appDir, 'younmesign-usage-e2e', () => undefined);
  await owner.connect();
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password, email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted' }).eq('user_id', u.id);
  const org = (await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single()).data.org_id;
  for (const k of (await rpc(db, 'api_key_list', { p_actor: u.id, p_org: org })).filter((k) => !k.revoked_at)) await rpc(db, 'revoke_api_key', { p_actor: u.id, p_key_id: k.id });
  const key = `ynms_${randomBytes(32).toString('base64url')}`;
  await rpc(db, 'create_api_key', { p_actor: u.id, p_org: org, p_name: 'Usage', p_scopes: ['documents:read'], p_prefix: key.slice(0, 12), p_key_sha256: createHash('sha256').update(key).digest('hex') });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    // ---------- counting ----------
    const before = (await rpc(db, 'usage_summary', { p_actor: u.id, p_org: org, p_month: null })).api_calls;
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push((await call(key)).status);
    const after = await rpc(db, 'usage_summary', { p_actor: u.id, p_org: org, p_month: null });
    check('five API requests are counted as exactly five for this workspace and month', answers.every((s) => s === 200) && after.api_calls - before === 5 && after.plan.id === 'free', `${before} -> ${after.api_calls}`);

    // ---------- Settings ----------
    const page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await page.type('#email', OWNER.email);
    await page.type('#password', password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('form button[type="submit"]')]);
    await page.goto(`${APP}/app/settings`, { waitUntil: 'networkidle0' });
    const shown = await page.$$eval('[data-testid="usage"] > div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])));
    const heading = await page.$eval('#usage-heading', (e) => e.textContent ?? '');
    const now = await rpc(db, 'usage_summary', { p_actor: u.id, p_org: org, p_month: null });
    check('Settings shows the plan and this month\u2019s usage, equal to the database\u2019s summary',
      heading.includes('Free plan') && shown['API requests'] === `${now.api_calls.toLocaleString('en-US')} (no limit)` && shown['API keys'] === `${now.api_keys} of 10`
        && shown['Webhook endpoints'] === `${now.webhook_endpoints} of 10` && shown['Documents sent'] === String(now.documents_sent) && shown['Active members'] === String(now.members)
        && shown['API requests a minute, per key'] === 'up to 60',
      JSON.stringify(shown));

    // ---------- limits from the plan ----------
    await owner.query(`insert into public.plans (id, name, offered, max_api_keys, max_webhook_endpoints, api_requests_per_minute, monthly_api_calls, note)
                       values ($1, 'E2E tight (test only)', false, 10, 10, 3, $2, 'Made by usage-e2e; removed at the end') on conflict (id) do update set api_requests_per_minute = 3, monthly_api_calls = $2`,
      [TEST_PLAN, now.api_calls + 5]);
    await owner.query('insert into public.org_plans (org_id, plan_id) values ($1, $2) on conflict (org_id) do update set plan_id = $2', [org, TEST_PLAN]);
    // per minute: start early in a clock minute so all four land in the same one
    const into = (Date.now() / 1000) % 60;
    if (into > 40) await new Promise((r) => setTimeout(r, (61 - into) * 1000));
    const minute = [];
    for (let i = 0; i < 4; i++) minute.push(await call(key));
    check('the per-minute limit comes from the plan: 3 allowed, the 4th refused with 429 and Retry-After',
      minute.slice(0, 3).every((r) => r.status === 200) && minute[3].status === 429 && minute[3].body?.error?.code === 'rate_limited' && minute[3].body.error.message.includes('at most 3 a minute'),
      minute.map((r) => r.status).join(','));
    // monthly: the plan allows the count so far + 5; requests past that are refused until the 1st
    const monthly = [];
    for (let i = 0; i < 3; i++) monthly.push(await call(key));
    const nextMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1);
    const retry = Number(monthly.at(-1).retry);
    check('a monthly limit from the plan refuses further requests with 429 "monthly_limit" and a Retry-After to the 1st (UTC)',
      monthly.at(-1).status === 429 && monthly.at(-1).body?.error?.code === 'monthly_limit' && Math.abs(Date.now() + retry * 1000 - nextMonth) < 120_000,
      `${monthly.map((r) => `${r.status}:${r.body?.error?.code ?? 'ok'}`).join(',')} retry=${retry}`);
    await page.goto(`${APP}/app/settings`, { waitUntil: 'networkidle0' });
    const tight = await page.$$eval('[data-testid="usage"] > div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])));
    const tightHeading = await page.$eval('#usage-heading', (e) => e.textContent ?? '');
    check('Settings shows the other plan\u2019s name and limits', tightHeading.includes('E2E tight (test only) plan') && / of [\d,]+$/.test(tight['API requests']) && tight['API requests a minute, per key'] === 'up to 3', JSON.stringify(tight));
  } finally {
    await owner.query('delete from public.org_plans where org_id = $1', [org]).catch(() => undefined);
    await owner.query('delete from public.plans where id = $1', [TEST_PLAN]).catch(() => undefined);
    await browser.close();
  }
  // back on free: the next minute's request works again
  const into = (Date.now() / 1000) % 60;
  await new Promise((r) => setTimeout(r, (61 - into) * 1000));
  const back = await call(key);
  const left = await owner.query('select count(*)::int as n from public.plans where id = $1', [TEST_PLAN]);
  check('after the test plan is removed the workspace is on Free again and the key works', back.status === 200 && left.rows[0].n === 0, `status=${back.status}`);
  await owner.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `USAGE E2E FAILED (${failed} of ${results.length})` : `USAGE E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`USAGE E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
