// npm run e2e:webhooks [-- --app http://localhost:3000]
// End-to-end check of webhooks (Phase 5 slice 3, AT5.2, D-92). A small receiver runs on this PC (allowed only by the
// development setting WEBHOOK_ALLOW_LOOPBACK=1 while APP_URL is localhost). In Settings → Webhooks: a private address
// is refused; an endpoint is added and its secret shown once; a test event arrives signed. A document is then created,
// sent and signed over the API: document.sent, person.completed and document.completed arrive, each verified with the
// receiver code published on /developers, each matching the documented schema. A receiver that fails first is retried
// after the documented wait (fast-forwarded here; the full schedule is checked by the SQL tests) and the delivery log
// shows both attempts. A changed secret signs alongside the old one; a replayed or altered request fails the check; an
// endpoint pointed at a private address (added behind the app's back) is refused by the worker before any connection.
// Needs the app AND the background worker running (started with the setting above). Synthetic accounts only.
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const { webhookEvent } = await import(pathToFileURL(path.join(appDir, 'src', 'lib', 'api', 'schemas.ts')).href);
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OWNER = { email: 'hooks-owner@example.test', name: 'Hana Hooks' };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const tag = randomBytes(3).toString('hex');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 60_000, every = 500) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(every);
  }
}

// ---------- the receiver's check: the same code as on /developers ----------
function verifyWebhook(secret, headers, rawBody, now = Date.now() / 1000) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  if (!id || !/^\d+$/.test(ts ?? '') || Math.abs(now - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  return (headers['webhook-signature'] ?? '').split(' ').some((part) => {
    const [version, sig] = part.split(',');
    const got = Buffer.from(sig ?? '', 'base64');
    return version === 'v1' && got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// ---------- a receiver on this PC ----------
const received = [];
let flakyCalls = 0;
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, body, at: Date.now() });
    if (req.url === '/flaky' && ++flakyCalls === 1) res.writeHead(503).end('busy');
    else res.writeHead(204).end();
  });
});

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function api(key, method, p, body) {
  const res = await fetch(`${APP}${p}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function makeTemplate(db, u, org) {
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Hook source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Order form ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'order.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Buyer', email: `hooks-buyer-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  const copied = await db.storage.from('originals').copy(srcPath, tplPath);
  if (copied.error) throw new Error(`template copy: ${copied.error.message}`);
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `Order form ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Buyer' }], p_storage_path: tplPath });
  return templateId;
}

/** The app's stored-secret format (src/lib/webhooks/secret-box.ts), for the endpoint added behind the app's back. */
function sealSecret(secret, endpointId) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(process.env.STORAGE_KEY, 'base64url'), Buffer.from('younmesign-webhooks'), Buffer.from('webhook secret box v1'), 32));
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(endpointId, 'utf8'));
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url')}`;
}

const endpointRow = (page, url) => page.waitForSelector(`xpath/.//li[.//p[normalize-space()="${url}"]]`);
async function clickIn(page, url, label) {
  const li = await endpointRow(page, url);
  // buttons are disabled while the previous action's refresh is still running
  const btn = await li.waitForSelector(`xpath/.//button[normalize-space()="${label}" and not(@disabled)]`, { timeout: 20000 });
  await btn.click();
}

async function addEndpoint(page, url, events) {
  await page.goto(`${APP}/app/settings/webhooks`, { waitUntil: 'networkidle0' });
  await page.click('#webhook-url', { clickCount: 3 });
  await page.type('#webhook-url', url);
  for (const box of await page.$$('input[name="webhook-event"]')) {
    const [value, on] = await box.evaluate((e) => [e.value, e.checked]);
    if (on !== events.includes(value)) await box.click();
  }
  await page.click('button::-p-text(Add the endpoint)');
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  if (process.env.WEBHOOK_ALLOW_LOOPBACK !== '1') throw new Error('Set WEBHOOK_ALLOW_LOOPBACK=1 in .env.local and restart the app and the worker (see RUNBOOK, Webhooks).');
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const port = receiver.address().port;
  const OK_URL = `http://127.0.0.1:${port}/ok`;
  const FLAKY_URL = `http://127.0.0.1:${port}/flaky`;
  console.log(`Webhooks end-to-end check against ${APP} (receiver on port ${port})`);

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password, email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;
  // earlier runs: their endpoints and keys go
  for (const e of await rpc(db, 'webhook_endpoint_list', { p_actor: u.id, p_org: org })) await rpc(db, 'webhook_endpoint_delete', { p_actor: u.id, p_id: e.id });
  for (const k of (await rpc(db, 'api_key_list', { p_actor: u.id, p_org: org })).filter((k) => !k.revoked_at)) await rpc(db, 'revoke_api_key', { p_actor: u.id, p_key_id: k.id });
  const templateId = await makeTemplate(db, u, org);
  const apiKey = `ynms_${randomBytes(32).toString('base64url')}`;
  await rpc(db, 'create_api_key', { p_actor: u.id, p_org: org, p_name: `Hooks ${tag}`, p_scopes: ['documents:read', 'documents:write', 'documents:send'], p_prefix: apiKey.slice(0, 12), p_key_sha256: createHash('sha256').update(apiKey).digest('hex') });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const owner = await browser.newPage();
    await owner.setBypassCSP(true);
    await owner.setViewport({ width: 1280, height: 1000 });
    await owner.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await owner.type('#email', OWNER.email);
    await owner.type('#password', password);
    await Promise.all([owner.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), owner.click('form button[type="submit"]')]);

    // ---------- refused addresses ----------
    await addEndpoint(owner, 'https://169.254.169.254/latest/meta-data', ['document.completed']);
    await owner.waitForSelector('[role="alert"]', { timeout: 20000 });
    const refusedText = await owner.$eval('[role="alert"]', (e) => e.textContent ?? '');
    await addEndpoint(owner, 'http://hooks.example.com/in', ['document.completed']);
    await owner.waitForSelector('[role="alert"]', { timeout: 20000 });
    const httpText = await owner.$eval('[role="alert"]', (e) => e.textContent ?? '');
    const none = await rpc(db, 'webhook_endpoint_list', { p_actor: u.id, p_org: org });
    check('Settings refuses a private address (cloud metadata) and plain http, and saves nothing', refusedText.includes('private or reserved network') && httpText.includes('https://') && none.length === 0, refusedText.slice(0, 60));

    // ---------- add, secret once, test event ----------
    await addEndpoint(owner, OK_URL, ['document.sent', 'document.completed', 'person.completed']);
    await owner.waitForSelector('[data-testid="new-webhook-secret"]', { timeout: 20000 });
    const secret = await owner.$eval('[data-testid="new-webhook-secret"]', (e) => e.textContent?.trim() ?? '');
    await owner.click('button::-p-text(I have stored it)');
    const [okRow] = (await db.from('webhook_endpoints').select('id, secret_enc').eq('org_id', org).eq('url', OK_URL)).data ?? [];
    await owner.reload({ waitUntil: 'networkidle0' });
    const shownAgain = (await owner.content()).includes(secret);
    check('an endpoint is added; its secret is shown once, stored only encrypted, and not shown again',
      /^whsec_[A-Za-z0-9+/]{43}=$/.test(secret) && okRow && !okRow.secret_enc.includes(secret.slice(6, 26)) && !shownAgain);
    await clickIn(owner, OK_URL, 'Send a test event');
    const test = await waitFor(() => received.find((r) => r.path === '/ok' && JSON.parse(r.body).type === 'webhook.test'), 30000);
    check('"Send a test event" arrives signed, and the published check accepts it', !!test && verifyWebhook(secret, test.headers, test.body) && test.headers['content-type'] === 'application/json' && webhookEvent.safeParse(JSON.parse(test.body)).success,
      test ? `webhook-id ${test.headers['webhook-id']}` : 'nothing arrived');

    // ---------- a receiver that fails first ----------
    await addEndpoint(owner, FLAKY_URL, ['document.completed']);
    await owner.waitForSelector('[data-testid="new-webhook-secret"]', { timeout: 20000 });
    const flakySecret = await owner.$eval('[data-testid="new-webhook-secret"]', (e) => e.textContent?.trim() ?? '');
    await owner.click('button::-p-text(I have stored it)');
    const [flakyRow] = (await db.from('webhook_endpoints').select('id').eq('org_id', org).eq('url', FLAKY_URL)).data ?? [];

    // ---------- a document over the API ----------
    const created = await api(apiKey, 'POST', '/api/v1/documents', { template_id: templateId, title: `Hook order ${tag}`, people: [{ role: 'Buyer', name: 'Bo Buyer', email: `hooks-bo-${tag}@example.test` }] });
    const id = created.data?.id;
    const sent = await api(apiKey, 'POST', `/api/v1/documents/${id}/send`, { delivery: 'link', expires_in_days: 7 });
    const link = sent.data?.signing_links?.[0]?.url;
    if (!link) throw new Error(`could not send the test document (create ${created.status}, send ${sent.status})`);
    const signer = await (await browser.createBrowserContext()).newPage();
    await signer.setBypassCSP(true);
    await signer.setViewport({ width: 1280, height: 1000 });
    await signer.goto(link, { waitUntil: 'networkidle0' });
    await signer.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await signer.click('input[name="agree"]');
    await signer.click('button::-p-text(Agree and continue)');
    await signer.waitForSelector('button[aria-label^="Sign here"]', { timeout: 30000 });
    await signer.click('button[aria-label^="Sign here"]');
    await signer.waitForSelector('[role="tablist"]', { visible: true });
    await signer.click('[role="tab"]::-p-text(Type)');
    await signer.click('button::-p-text(Use this signature)');
    await signer.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await signer.click('button::-p-text(Finish)');
    await signer.waitForSelector('#finish-title', { visible: true });
    await signer.click('button::-p-text(Adopt and Sign)');

    const ofDoc = (p, type) => received.find((r) => r.path === p && (() => { const b = JSON.parse(r.body); return b.type === type && b.data?.document?.id === id; })());
    const events = await waitFor(() => {
      const all = ['document.sent', 'person.completed', 'document.completed'].map((t) => ofDoc('/ok', t));
      return all.every(Boolean) ? all : null;
    }, 120000, 1000);
    const parsed = (events ?? []).map((r) => JSON.parse(r.body));
    check('document.sent, person.completed and document.completed arrive for the document, each signed and passing the published check',
      !!events && events.every((r) => verifyWebhook(secret, r.headers, r.body)), events ? '' : `received ${received.map((r) => JSON.parse(r.body).type).join(', ')}`);
    check('each payload matches the documented schema (strict), with the right content and no signing link',
      parsed.length === 3 && parsed.every((b) => webhookEvent.safeParse(b).success) && parsed[1].data.person?.name === 'Bo Buyer' && parsed[1].data.person?.status === 'signed'
        && parsed[2].data.document.status === 'completed' && parsed[2].data.document.sealed === true && !(events ?? []).some((r) => r.body.includes('/s#')),
      parsed.map((b) => (webhookEvent.safeParse(b).success ? 'ok' : JSON.stringify(webhookEvent.safeParse(b).error?.issues?.[0] ?? {}))).join(', '));
    const delivery = (await db.from('webhook_deliveries').select('id, attempts, status').eq('endpoint_id', okRow.id).eq('envelope_id', id).eq('event_type', 'document.completed').single()).data;
    check('webhook-id is the delivery\u2019s id (the same on every retry)', events?.[2]?.headers['webhook-id'] === delivery?.id && delivery?.status === 'delivered');

    // ---------- replay and tampering ----------
    const sample = events?.[2];
    check('replay protection: the same request presented 6 minutes later fails the check; an altered body or id fails too',
      !!sample && !verifyWebhook(secret, sample.headers, sample.body, Number(sample.headers['webhook-timestamp']) + 360)
        && !verifyWebhook(secret, sample.headers, sample.body.replace('completed', 'declined'))
        && !verifyWebhook(secret, { ...sample.headers, 'webhook-id': randomUUID() }, sample.body)
        && !verifyWebhook(flakySecret, sample.headers, sample.body));

    // ---------- retry with backoff ----------
    const firstTry = await waitFor(async () => {
      const d = (await db.from('webhook_deliveries').select('id, status, attempts, next_attempt_at, last_status_code').eq('endpoint_id', flakyRow.id).eq('envelope_id', id).maybeSingle()).data;
      return d && d.attempts === 1 ? d : null;
    }, 60000);
    const wait = firstTry ? (new Date(firstTry.next_attempt_at).getTime() - Date.now()) / 1000 : -1;
    check('a receiver answering 503 is retried after the documented wait (about 60 s for the second attempt)', firstTry?.status === 'pending' && firstTry.last_status_code === 503 && wait > 30 && wait <= 61, `next try in ${Math.round(wait)} s`);
    // fast-forward the wait (the full schedule 1 min … 12 h is checked by supabase/tests/phase5_slice3_webhooks.sql T744)
    await db.from('webhook_deliveries').update({ next_attempt_at: new Date().toISOString() }).eq('id', firstTry?.id);
    const second = await waitFor(async () => (await db.from('webhook_deliveries').select('status, attempts').eq('id', firstTry?.id).single()).data?.status === 'delivered', 30000);
    const flakyHits = received.filter((r) => r.path === '/flaky');
    check('the second attempt is delivered, with the same webhook-id and a fresh timestamp and signature',
      !!second && flakyHits.length === 2 && flakyHits[0].headers['webhook-id'] === flakyHits[1].headers['webhook-id'] && flakyHits.every((r) => verifyWebhook(flakySecret, r.headers, r.body)));
    await owner.goto(`${APP}/app/settings/webhooks?log=${flakyRow.id}`, { waitUntil: 'networkidle0' });
    await owner.click('summary::-p-text(Every attempt (2))');
    const logText = await owner.$eval('#delivery-log', (e) => e.innerText);
    check('the delivery log shows the delivery and both attempts (HTTP 503, then HTTP 204)', /Delivered/.test(logText) && /HTTP 503/.test(logText) && /HTTP 204/.test(logText) && logText.includes(firstTry?.id ?? '-'));

    // ---------- secret change ----------
    await owner.goto(`${APP}/app/settings/webhooks`, { waitUntil: 'networkidle0' });
    await clickIn(owner, OK_URL, 'Change the secret');
    await owner.waitForSelector('[data-testid="new-webhook-secret"]', { timeout: 20000 });
    const newSecret = await owner.$eval('[data-testid="new-webhook-secret"]', (e) => e.textContent?.trim() ?? '');
    await owner.click('button::-p-text(I have stored it)');
    const before = received.length;
    await clickIn(owner, OK_URL, 'Send a test event');
    const rotated = await waitFor(() => received.slice(before).find((r) => r.path === '/ok'), 30000);
    check('after a secret change both the new and the previous secret sign (two signatures) for the changeover',
      newSecret !== secret && !!rotated && rotated.headers['webhook-signature'].split(' ').length === 2 && verifyWebhook(newSecret, rotated.headers, rotated.body) && verifyWebhook(secret, rotated.headers, rotated.body));

    // ---------- the worker's own guard ----------
    const sneakyId = randomUUID();
    await rpc(db, 'webhook_endpoint_create', { p_actor: u.id, p_org: org, p_id: sneakyId, p_url: 'https://10.255.255.1/x', p_description: 'behind the app', p_events: ['document.voided'], p_secret_enc: sealSecret(`whsec_${randomBytes(32).toString('base64')}`, sneakyId) });
    const sneakyDelivery = await rpc(db, 'webhook_test', { p_actor: u.id, p_id: sneakyId });
    const blocked = await waitFor(async () => {
      const d = (await db.from('webhook_deliveries').select('attempts, last_error').eq('id', sneakyDelivery).single()).data;
      return d && d.attempts >= 1 ? d : null;
    }, 30000);
    check('an endpoint pointed at a private address behind the app\u2019s back is refused by the worker before any connection',
      blocked?.last_error?.startsWith('Not sent:') === true, blocked?.last_error ?? 'no attempt');
    await rpc(db, 'webhook_endpoint_delete', { p_actor: u.id, p_id: sneakyId });

    // ---------- switch off, delete ----------
    await owner.goto(`${APP}/app/settings/webhooks`, { waitUntil: 'networkidle0' });
    await clickIn(owner, FLAKY_URL, 'Switch off');
    await owner.waitForFunction(() => document.body.innerText.includes('Switched off. Nothing more is sent'), { timeout: 20000 });
    await clickIn(owner, OK_URL, 'Delete');
    await clickIn(owner, OK_URL, 'Yes, delete it');
    await owner.waitForFunction(() => document.body.innerText.includes('Deleted, with its delivery log.'), { timeout: 20000 });
    const left = await rpc(db, 'webhook_endpoint_list', { p_actor: u.id, p_org: org });
    const audit = (await db.from('audit_events').select('event_type, payload').eq('chain_key', `org:${org}`).in('event_type', ['webhook_created', 'webhook_deleted', 'webhook_secret_changed', 'webhook_changed'])).data ?? [];
    check('switching off and deleting work from Settings, and every change is in the workspace audit trail (address host only)',
      left.length === 1 && left[0].enabled === false && audit.length >= 5 && !audit.some((a) => JSON.stringify(a.payload).includes('/ok')));
  } finally {
    await browser.close();
    receiver.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `WEBHOOKS E2E FAILED (${failed} of ${results.length})` : `WEBHOOKS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`WEBHOOKS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  receiver.close();
  process.exit(1);
});
