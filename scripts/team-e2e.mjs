// npm run e2e:team [-- --app http://localhost:3000]
// End-to-end check of teams through the real pages (Phase 4 slice 1, D-75), in two separate browser sessions:
// the owner invites on the Team page -> the colleague opens the link and joins as a member -> the member cannot see
// the owner's documents, the owner sees the member's -> the owner deactivates the member -> the member is locked out.
// Synthetic accounts team-owner@example.test and team-mate@example.test; passwords are made up fresh for each run,
// kept in memory only and never printed. Uses the Chrome installed on this PC. Exit code 1 if any check fails.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-core';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OWNER = 'team-owner@example.test';
const MATE = 'team-mate@example.test';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

async function account(db, email, name) {
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === email);
  if (!u) {
    const c = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
    if (c.error) throw new Error(`createUser: ${c.error.message}`);
    u = c.data.user;
  } else {
    const r = await db.auth.admin.updateUserById(u.id, { password });
    if (r.error) throw new Error(`updateUser: ${r.error.message}`);
  }
  // 'trusted': keeps these synthetic accounts out of the small daily email pool that new accounts share
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  return { id: u.id, password, orgId: m.org_id };
}

async function signIn(page, email, password) {
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
  await page.type('#email', email);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('form button[type="submit"]')]);
}
// Pages stream, so a "not found" can arrive inside a 200 response: judge by what the page shows, not the status code.
const notShown = async (page, url, title) => {
  await page.goto(url, { waitUntil: 'networkidle0' });
  const t = await page.evaluate(() => document.body.innerText);
  return /could not be found/i.test(t) && !t.includes(title);
};
const text = (page) => page.evaluate(() => document.body.innerText);

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Team end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const owner = await account(db, OWNER, 'Tess Teamowner');
  const mate = await account(db, MATE, 'Matt Teammate');
  // start clean: the colleague is not in the owner's team and has no open invitation there
  await db.from('memberships').delete().eq('org_id', owner.orgId).eq('user_id', mate.id);
  await db.from('team_invitations').update({ revoked_at: new Date().toISOString() }).eq('org_id', owner.orgId).is('accepted_at', null).is('revoked_at', null);
  // repeated runs would use up the synthetic colleague's 10 joins an hour (the limit is real; this clears only theirs)
  await db.from('rate_limits').delete().eq('bucket', 'team_join').eq('key_hash', `\\x${createHash('sha256').update(mate.id).digest('hex')}`);
  const stamp = randomBytes(3).toString('hex');
  const { data: ownerDoc, error: e1 } = await db.rpc('create_envelope', { p_actor: owner.id, p_org_id: owner.orgId, p_title: `Owner private draft ${stamp}`, p_folder_id: null });
  if (e1) throw new Error(`create_envelope: ${e1.message}`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const a = await (await browser.createBrowserContext()).newPage();
    const b = await (await browser.createBrowserContext()).newPage();
    for (const p of [a, b]) {
      await p.setBypassCSP(true);
      await p.setViewport({ width: 1280, height: 900 });
    }
    a.on('dialog', (d) => void d.accept());

    // 1. owner invites on the Team page
    await signIn(a, OWNER, owner.password);
    await a.goto(`${APP}/app/team`, { waitUntil: 'networkidle0' });
    await a.type('#invite-email', MATE);
    await a.select('#invite-role', 'member');
    await a.click('form button[type="submit"]::-p-text(Create invitation)');
    await a.waitForSelector('#invite-link', { timeout: 20000 });
    const link = await a.$eval('#invite-link', (el) => el.value);
    check('the owner creates an invitation on the Team page and gets a one-time link', /\/join#[A-Za-z0-9_-]{43}$/.test(link));

    // 2. the colleague signs in and opens the link
    await signIn(b, MATE, mate.password);
    await b.goto(link, { waitUntil: 'networkidle0' });
    await b.waitForFunction(() => location.pathname === '/app', { timeout: 30000 }).catch(async () => {
      throw new Error(`joining did not reach /app; page ${b.url().replace(APP, '')} said: ${(await text(b)).replace(/\s+/g, ' ').slice(0, 200)}`);
    });
    const bar = await text(b);
    check('the colleague opens the link, joins, and lands in the team workspace', bar.includes('Member') && (await b.$('#workspace-switch')) !== null);
    const leftInStorage = await b.evaluate(() => sessionStorage.getItem('ynms-team-invite'));
    check('the invitation secret is not left behind in the browser', leftInStorage === null);
    {
      const c = await (await browser.createBrowserContext()).newPage();
      await signIn(c, MATE, mate.password);
      await c.goto(link, { waitUntil: 'networkidle0' });
      await c.waitForFunction(() => /not valid any more|already in this team/.test(document.body.innerText), { timeout: 20000 }).catch(() => null);
      const t = await text(c);
      const refused = /not valid any more|already in this team/.test(t);
      check('the same link does not work a second time', refused, refused ? '' : `page at ${c.url().replace(APP, '')} said: ${t.replace(/\s+/g, ' ').slice(0, 160)}`);
    }

    // 3. what each one sees
    const dash = await text(b);
    check("the member does not see the owner's document on the team dashboard", !dash.includes(`Owner private draft ${stamp}`));
    check("the member gets 'not found' opening the owner's document directly", await notShown(b, `${APP}/app/envelopes/${ownerDoc.id}`, `Owner private draft ${stamp}`));
    const { data: mateDoc, error: e2 } = await db.rpc('create_envelope', { p_actor: mate.id, p_org_id: owner.orgId, p_title: `Member document ${stamp}`, p_folder_id: null });
    if (e2) throw new Error(`create_envelope (member): ${e2.message}`);
    await a.goto(`${APP}/app?q=${encodeURIComponent(`Member document ${stamp}`)}`, { waitUntil: 'networkidle0' });
    check("the owner sees the member's document", (await text(a)).includes(`Member document ${stamp}`));
    await a.goto(`${APP}/app/team`, { waitUntil: 'networkidle0' });
    check('the Team page lists the member with their role', (await text(a)).includes(`${MATE} · Member`));

    // 4. the owner deactivates the member
    await a.click('button[aria-label^="Deactivate: "]');
    await a.waitForFunction(() => /Deactivated\./.test(document.body.innerText), { timeout: 20000 });
    check("the member is locked out of the team at once (their documents in it return 'not found')", await notShown(b, `${APP}/app/envelopes/${mateDoc.id}`, `Member document ${stamp}`));
    await b.goto(`${APP}/app`, { waitUntil: 'networkidle0' });
    check('the member is back in their own workspace with no team to switch to', (await b.$('#workspace-switch')) === null);
    await a.goto(`${APP}/app?q=${encodeURIComponent(`Member document ${stamp}`)}`, { waitUntil: 'networkidle0' });
    check("the member's document stays with the team", (await text(a)).includes(`Member document ${stamp}`));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `TEAM E2E FAILED (${failed} of ${results.length})` : `TEAM E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`TEAM E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
