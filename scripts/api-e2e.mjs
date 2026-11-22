// npm run e2e:api [-- --app http://localhost:3000]
// End-to-end check of the REST API (Phase 5 slice 1, AT5.1, D-90): keys are made in Settings; then, over HTTP only:
// list templates → create a document (idempotent) → send it → the signer signs in a browser → poll until sealed →
// download the sealed PDF and certificate. Also: a read-only key gets 403 for sending; a wrong or revoked key 401;
// another workspace's document 404; too many requests 429 with Retry-After.
// Needs the app AND the background worker running. Synthetic accounts only. Signs in once.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OWNER = { email: 'api-owner@example.test', name: 'Abe Api' };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const tag = randomBytes(3).toString('hex');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function api(key, method, p, body, headers = {}) {
  const res = await fetch(`${APP}${p}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
}

async function makeTemplate(db, u, org) {
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `API source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Service agreement ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'agreement.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Client', email: `e2e-client-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  const copied = await db.storage.from('originals').copy(srcPath, tplPath);
  if (copied.error) throw new Error(`template copy: ${copied.error.message}`);
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `Service agreement ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Client' }], p_storage_path: tplPath });
  return templateId;
}

async function createKey(page, name, scopes) {
  await page.goto(`${APP}/app/settings`, { waitUntil: 'networkidle0' });
  await page.type('#api-key-name', name);
  for (const s of ['documents:read', 'documents:write', 'documents:send']) {
    const box = await page.$(`input[name="api-scope"][value="${s}"]`);
    const on = await box.evaluate((e) => e.checked);
    if (on !== scopes.includes(s)) await box.click();
  }
  await page.click('button::-p-text(Create an API key)');
  await page.waitForSelector('[data-testid="new-api-key"]', { timeout: 20000 });
  return page.$eval('[data-testid="new-api-key"]', (e) => e.textContent?.trim() ?? '');
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`REST API end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password, email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;
  // earlier runs' keys are revoked so the 10-key limit is never reached
  for (const k of (await rpc(db, 'api_key_list', { p_actor: u.id, p_org: org })).filter((k) => !k.revoked_at)) await rpc(db, 'revoke_api_key', { p_actor: u.id, p_key_id: k.id });
  const templateId = await makeTemplate(db, u, org);
  // a document in somebody else's workspace, for the 404 check
  const { data: other } = await db.from('envelopes').select('id').neq('org_id', org).limit(1).single();

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const owner = await browser.newPage();
    await owner.setBypassCSP(true);
    await owner.setViewport({ width: 1280, height: 1000 });
    await owner.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await owner.type('#email', OWNER.email);
    await owner.type('#password', password);
    await Promise.all([owner.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), owner.click('form button[type="submit"]')]);

    const key = await createKey(owner, `CRM ${tag}`, ['documents:read', 'documents:write', 'documents:send']);
    const reader = await createKey(owner, `Reader ${tag}`, ['documents:read']);
    const stored = await db.from('api_keys').select('key_sha256, prefix').eq('org_id', org).is('revoked_at', null);
    check('keys are made in Settings and shown once; only their fingerprints are stored',
      /^ynms_[A-Za-z0-9_-]{43}$/.test(key) && stored.data?.length === 2 && stored.data.some((k) => k.key_sha256 === createHash('sha256').update(key).digest('hex') && k.prefix === key.slice(0, 12)));

    // ---------- create (idempotent) ----------
    const tpls = await api(key, 'GET', '/api/v1/templates');
    const tpl = tpls.data.templates?.find((t) => t.id === templateId);
    const body = { template_id: templateId, title: `API agreement ${tag}`, people: [{ role: 'Client', name: 'Cleo Client', email: `e2e-cleo-${tag}@example.test` }] };
    const idem = `create-${tag}`;
    const c1 = await api(key, 'POST', '/api/v1/documents', body, { 'Idempotency-Key': idem });
    const c2 = await api(key, 'POST', '/api/v1/documents', body, { 'Idempotency-Key': idem });
    const c3 = await api(key, 'POST', '/api/v1/documents', { ...body, title: 'Different' }, { 'Idempotency-Key': idem });
    const { count: made } = await db.from('envelopes').select('id', { count: 'exact', head: true }).eq('title', `API agreement ${tag}`);
    check('templates are listed with their roles; a document is created; the same request again is replayed, not repeated; a different one with the same key is refused',
      tpls.status === 200 && tpl?.roles?.[0]?.label === 'Client' && c1.status === 201 && c1.data.status === 'draft' && c2.status === 201 && c2.data.id === c1.data.id
        && c2.headers.get('idempotent-replayed') === 'true' && c3.status === 422 && made === 1,
      `create=${c1.status} replay=${c2.status} other=${c3.status} documents=${made}`);
    const id = c1.data.id;

    // ---------- permissions ----------
    const forbidden = await api(reader, 'POST', `/api/v1/documents/${id}/send`, { delivery: 'link' });
    const noKey = await api(null, 'GET', `/api/v1/documents/${id}`);
    const badKey = await api(`ynms_${'A'.repeat(43)}`, 'GET', `/api/v1/documents/${id}`);
    const foreign = await api(key, 'GET', `/api/v1/documents/${other.id}`);
    check('a read-only key cannot send (403); no key or a wrong key gets 401; another workspace\u2019s document is 404',
      forbidden.status === 403 && forbidden.data.error?.code === 'forbidden' && noKey.status === 401 && badKey.status === 401 && foreign.status === 404,
      `${forbidden.status}/${noKey.status}/${badKey.status}/${foreign.status}`);

    // ---------- send, sign, poll, download ----------
    const sent = await api(key, 'POST', `/api/v1/documents/${id}/send`, { delivery: 'link', expires_in_days: 7 }, { 'Idempotency-Key': `send-${tag}` });
    const link = sent.data.signing_links?.[0]?.url;
    check('sending answers with the signing link to pass on', sent.status === 200 && sent.data.document?.status === 'sent' && /\/s#[A-Za-z0-9_-]{43}$/.test(link ?? ''), `status=${sent.status}`);
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
    let view = null;
    for (let i = 0; i < 60; i++) {
      view = (await api(key, 'GET', `/api/v1/documents/${id}`)).data;
      if (view.status === 'completed' && view.sealed) break;
      await sleep(2000);
    }
    const pdf = await api(key, 'GET', `/api/v1/documents/${id}/download?part=sealed`);
    const cert = await api(reader, 'GET', `/api/v1/documents/${id}/download?part=certificate`);
    check('polling shows the document completed and sealed; the sealed PDF and certificate download with the key',
      view?.status === 'completed' && view.people?.[0]?.status === 'signed' && pdf.status === 200 && Buffer.isBuffer(pdf.data) && pdf.data.subarray(0, 5).toString() === '%PDF-'
        && cert.status === 200 && cert.data.subarray(0, 5).toString() === '%PDF-',
      `status=${view?.status}`);

    // ---------- rate limit and revocation ----------
    const { data: readerRow } = await db.from('api_keys').select('id').eq('key_sha256', createHash('sha256').update(reader).digest('hex')).single();
    // the limit counts per clock minute: fill it all at once, early enough in a minute that the next request is in the same one
    const intoMinute = (Date.now() / 1000) % 60;
    if (intoMinute > 45) await sleep((61 - intoMinute) * 1000);
    await Promise.all(Array.from({ length: 60 }, () => rpc(db, 'rate_limit_hit', { p_bucket: 'api_key', p_key: readerRow.id, p_limit: 60, p_window_seconds: 60 })));
    const limited = await api(reader, 'GET', `/api/v1/documents/${id}`);
    const retry = Number(limited.headers.get('retry-after'));
    check('too many requests get 429 with Retry-After', limited.status === 429 && retry >= 1 && retry <= 60, `status=${limited.status} retry-after=${retry}`);
    await owner.goto(`${APP}/app/settings`, { waitUntil: 'networkidle0' });
    const row = await owner.waitForSelector(`xpath/.//li[.//text()[contains(., "Reader ${tag}")]]//button[normalize-space()="Revoke"]`);
    await row.click();
    await owner.waitForFunction(() => document.body.innerText.includes('Revoked. It stops working at once.'), { timeout: 20000 });
    const afterRevoke = await api(reader, 'GET', `/api/v1/templates`);
    check('a key revoked in Settings stops working at once (401)', afterRevoke.status === 401);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `API E2E FAILED (${failed} of ${results.length})` : `API E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  // the network error's own cause (for example a reset connection) and where it happened
  const cause = e instanceof Error && e.cause ? ` (${e.cause.code ?? ''} ${e.cause.message ?? e.cause})` : '';
  const where = e instanceof Error ? (e.stack ?? '').split('\n').slice(1, 4).join('\n') : '';
  console.error(`API E2E could not finish: ${e instanceof Error ? e.message : String(e)}${cause}\n${where}`);
  process.exit(1);
});
