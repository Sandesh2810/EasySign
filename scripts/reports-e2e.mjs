// npm run e2e:reports [-- --app http://localhost:3000]
// End-to-end check of reports (Phase 5 slice 4, AT5.4, D-93). The counting itself is proved against a hand-computed
// dataset by supabase/tests/phase5_slice4_reports.sql; this checks the page and the CSV people actually get. Its own
// synthetic workspace makes real history today through the REST API (one document signed and sealed, one voided, one
// left as a draft); the expected numbers are then counted here, independently, from the raw rows, and the Reports page
// and its CSV download must show exactly those. Needs the app AND the background worker running.
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
const OWNER = { email: 'reports-owner@example.test', name: 'Remy Reports' };
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
async function api(key, method, p, body) {
  const res = await fetch(`${APP}${p}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** A CSV reader for the check (quotes and doubled quotes; the app's own parser is tested separately). */
function readCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  return rows;
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Reports end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password, email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const org = (await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single()).data.org_id;
  for (const k of (await rpc(db, 'api_key_list', { p_actor: u.id, p_org: org })).filter((k) => !k.revoked_at)) await rpc(db, 'revoke_api_key', { p_actor: u.id, p_key_id: k.id });

  // a template, named like a formula on purpose (the CSV must neutralise it)
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Report source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Report test ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const src = `${org}/${env.id}/doc1.pdf`;
  await db.storage.from('originals').upload(src, bytes, { contentType: 'application/pdf', upsert: false });
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'r.pdf', p_storage_backend: 'supabase', p_storage_path: src,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Client', email: `rep-client-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  await db.storage.from('originals').copy(src, tplPath);
  const templateName = `=SUM(1,2) report ${tag}`;
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: templateName, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Client' }], p_storage_path: tplPath });
  const key = `ynms_${randomBytes(32).toString('base64url')}`;
  await rpc(db, 'create_api_key', { p_actor: u.id, p_org: org, p_name: `Reports ${tag}`, p_scopes: ['documents:read', 'documents:write', 'documents:send'], p_prefix: key.slice(0, 12), p_key_sha256: createHash('sha256').update(key).digest('hex') });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    // ---------- history: one signed and sealed, one voided, one draft ----------
    const make = async (title) => (await api(key, 'POST', '/api/v1/documents', { template_id: templateId, title, people: [{ role: 'Client', name: 'Cy Client', email: `rep-cy-${tag}@example.test` }] })).data.id;
    const [signedId, voidedId] = [await make(`Signed ${tag}`), await make(`Voided ${tag}`)];
    await make(`Draft ${tag}`);
    const link = (await api(key, 'POST', `/api/v1/documents/${signedId}/send`, { delivery: 'link' })).data?.signing_links?.[0]?.url;
    await api(key, 'POST', `/api/v1/documents/${voidedId}/send`, { delivery: 'link' });
    await rpc(db, 'void_envelope', { p_actor: u.id, p_envelope_id: voidedId, p_reason: 'Report test' });
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
    let sealed = false;
    for (let i = 0; i < 60 && !sealed; i++) {
      sealed = (await api(key, 'GET', `/api/v1/documents/${signedId}`)).data?.status === 'completed';
      if (!sealed) await sleep(2000);
    }
    check('history made through the API: one document signed and sealed, one voided, one left as a draft', sealed);

    // ---------- the expected numbers, counted here from the raw rows ----------
    const today = new Date().toISOString().slice(0, 10);
    const inDay = (t) => typeof t === 'string' && t.slice(0, 10) === today;
    const { data: rows } = await db.from('envelopes').select('id, sender_id, status, sent_at, completed_at, voided_at, expired_at').eq('org_id', org);
    const { data: people } = await db.from('recipients').select('envelope_id, status, completed_at, template_role_id').in('envelope_id', rows.map((e) => e.id));
    const { data: roles } = await db.from('template_roles').select('id, template_id').in('id', people.map((p) => p.template_role_id).filter(Boolean));
    const tplOf = (id) => roles.find((x) => people.some((p) => p.envelope_id === id && p.template_role_id === x.id))?.template_id ?? null;
    const expected = { sent: 0, completed: 0, declined: 0, voided: 0, expired: 0, hours: [] };
    const byTemplate = new Map();
    for (const e of rows) {
      if (!e.sent_at) continue;
      const declinedAt = e.status === 'declined' ? people.filter((p) => p.envelope_id === e.id && p.status === 'declined').map((p) => p.completed_at).sort().at(-1) : null;
      const n = { sent: inDay(e.sent_at), completed: e.status === 'completed' && inDay(e.completed_at), declined: inDay(declinedAt), voided: e.status === 'voided' && inDay(e.voided_at), expired: e.status === 'expired' && inDay(e.expired_at) };
      const t = tplOf(e.id);
      if (!byTemplate.has(t)) byTemplate.set(t, { sent: 0, completed: 0, declined: 0, voided: 0, expired: 0 });
      for (const k of Object.keys(n)) if (n[k]) { expected[k] += 1; byTemplate.get(t)[k] += 1; }
      if (n.completed) expected.hours.push((Date.parse(e.completed_at) - Date.parse(e.sent_at)) / 3_600_000);
    }
    const avg = expected.hours.length ? (expected.hours.reduce((a, b) => a + b, 0) / expected.hours.length).toFixed(1) : '';
    const tpl = byTemplate.get(templateId);

    // ---------- the page ----------
    const owner = await browser.newPage();
    await owner.setBypassCSP(true);
    await owner.setViewport({ width: 1280, height: 1000 });
    await owner.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await owner.type('#email', OWNER.email);
    await owner.type('#password', password);
    await Promise.all([owner.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), owner.click('form button[type="submit"]')]);
    await owner.goto(`${APP}/app/reports`, { waitUntil: 'networkidle0' });
    const defaultTo = await owner.$eval('#report-to', (e) => e.value);
    await owner.$eval('#report-from', (e, d) => { e.value = d; }, today);
    await owner.$eval('#report-to', (e, d) => { e.value = d; }, today);
    await Promise.all([owner.waitForNavigation({ waitUntil: 'networkidle0' }), owner.click('button::-p-text(Show)')]);
    const tiles = await owner.$$eval('[data-testid="report-totals"] > div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])));
    check('the period form defaults to a range ending today, and "Show" reloads the page for the chosen dates', defaultTo === today && owner.url().includes(`from=${today}&to=${today}`));
    check('the totals on the page equal the numbers counted from the raw rows',
      tiles.Sent === String(expected.sent) && tiles.Completed === String(expected.completed) && tiles.Declined === String(expected.declined) && tiles.Voided === String(expected.voided) && tiles.Expired === String(expected.expired)
        && expected.sent >= 2 && expected.completed >= 1 && expected.voided >= 1,
      JSON.stringify(tiles));
    const text = await owner.$eval('main', (e) => e.innerText);
    check('the person and the template are listed with their numbers', text.includes(OWNER.name) && text.includes(templateName) && text.includes(`${tpl?.sent} sent · ${tpl?.completed} completed`));

    // ---------- the CSV ----------
    const csv = await owner.evaluate(async (href) => {
      const r = await fetch(href);
      return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), body: await r.text() };
    }, `/api/reports?from=${today}&to=${today}`);
    const rowsCsv = readCsv(csv.body.replace(/^\uFEFF/, ''));
    const total = rowsCsv.find((x) => x[0] === 'total');
    const tplRow = rowsCsv.find((x) => x[0] === 'template' && x[1].includes(`report ${tag}`));
    check('"Download as CSV" gives a file with the same totals and average',
      csv.status === 200 && csv.type?.startsWith('text/csv') && csv.disposition === `attachment; filename="younmesign-report-${today}-to-${today}.csv"`
        && total?.join('|') === ['total', 'Whole workspace', expected.sent, expected.completed, expected.declined, expected.voided, expected.expired, avg].join('|'),
      total?.join(','));
    check('a template name that looks like a spreadsheet formula is neutralised in the CSV', tplRow?.[1] === `'${templateName}` && tplRow?.[2] === String(tpl?.sent));
    const outsider = await fetch(`${APP}/api/reports?from=${today}&to=${today}`);
    const bad = await owner.evaluate(async () => (await fetch('/api/reports?from=2026-03-31&to=2026-03-01')).status);
    check('the CSV needs a signed-in person, and a reversed period is refused', outsider.status === 401 && bad === 400, `${outsider.status}/${bad}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `REPORTS E2E FAILED (${failed} of ${results.length})` : `REPORTS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`REPORTS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
