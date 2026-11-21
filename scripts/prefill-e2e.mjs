// npm run e2e:prefill [-- --app http://localhost:3000]
// End-to-end check of prefilled values and merge text (Phase 4 slice 5, D-80) through the real pages and the real worker:
// * sending is refused, in plain words, when merge text has a misspelt placeholder;
// * the signer sees the sender's values with {{first_name}}, {{sender_name}} and {{document_title}} filled in; a locked
//   value cannot be typed over; prefilled required fields count as done; a prefilled number feeds a formula (slice 4);
// * the signer changes an unlocked value and signs; the sealed PDF shows the final values and the merged note.
// Needs the app AND the background worker running. Synthetic accounts only (fresh password each run, never printed).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import { deriveToken, hashToken, newNonce } from '../src/lib/signer-token.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OWNER = 'team-owner@example.test';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) text += ' ' + (await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str ?? '').join(' ');
  return text.replace(/\s+/g, ' ');
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Prefill and merge text end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER, password, email_confirm: true, user_metadata: { full_name: 'Tess Teamowner' } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;
  const { data: prof } = await db.from('profiles').select('display_name').eq('id', u.id).single();
  const senderName = prof?.display_name?.trim() || OWNER;

  const title = `Lease ${randomBytes(3).toString('hex')}`;
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: title, p_folder_id: null });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(`${title} ${randomUUID()}`, { x: 72, y: 740, size: 14, font });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'lease.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [signer] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Cleo Client', email: 'e2e-cleo5@example.test', role: 'signer', routing_order: 1 }] });
  const f = (type, y, extra = {}) => ({ document_id: doc.id, recipient_id: signer.id, type, page: 1, x: 0.1, y, w: 0.6, h: 0.035, ...extra });
  const layout = (greeting) => [
    f('company', 0.1, { options: { prefill: 'Acme Ltd', readonly: true } }),
    f('text', 0.15, { required: false, options: { prefill: greeting } }),
    f('number', 0.2, { w: 0.25, options: { name: 'rent', decimals: 0, prefill: '1200', readonly: true } }),
    f('formula', 0.25, { w: 0.25, required: false, options: { name: 'yearly', formula: 'rent * 12' } }),
    f('checkbox', 0.3, { w: 0.03, h: 0.022, required: true, options: { prefill: 'true' } }),
    f('note', 0.35, { h: 0.05, options: { text: 'Prepared by {{sender_name}} for {{name}} ({{document_title}})' } }),
    f('signature', 0.8, { w: 0.35, h: 0.07 }),
  ];
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: layout('Dear {{frist_name}}') });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    // ---------- 1. a misspelt placeholder stops sending ----------
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    await s.click('button[name="delivery"][value="link"]');
    await s.waitForFunction(() => document.body.innerText.includes('Not ready to send.'), { timeout: 20000 }).catch(() => null);
    const said = await s.evaluate(() => document.body.innerText);
    const draft = (await db.from('envelopes').select('status').eq('id', env.id).single()).data.status === 'draft';
    check('sending is refused, in plain words, for a misspelt merge field', draft && said.includes('"{{frist_name}}" is not a merge field'));

    // ---------- 2. corrected and sent ----------
    await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: layout('Dear {{first_name}}') });
    const tokenId = randomUUID();
    const nonce = newNonce();
    const token = deriveToken(process.env.SIGNER_TOKEN_KEY, tokenId, nonce);
    await rpc(db, 'send_envelope', { p_actor: u.id, p_envelope_id: env.id, p_tokens: [{ recipient_id: signer.id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
      p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link' });

    const page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await page.click('input[name="agree"]');
    await page.click('button::-p-text(Agree and continue)');
    await page.waitForSelector('input[aria-label^="Company"]', { timeout: 30000 });

    const company = await page.$eval('input[aria-label^="Company"]', (el) => ({ value: el.value, ro: el.readOnly, label: el.getAttribute('aria-label') }));
    const greeting = await page.$eval('input[aria-label^="Text"]', (el) => el.value);
    const body = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
    const merged = `Prepared by ${senderName} for Cleo Client (${title})`;
    check('the signer sees the prefilled values with merge text filled in (first name, sender, document title)',
      company.value === 'Acme Ltd' && greeting === 'Dear Cleo' && body.includes(merged), `greeting="${greeting}"`);
    check('a locked value is read-only and says it was filled in by the sender', company.ro && /filled in by the sender, cannot be changed/.test(company.label ?? ''));
    await page.click('input[aria-label^="Company"]');
    await page.keyboard.type('XYZ');
    check('typing over a locked value changes nothing', (await page.$eval('input[aria-label^="Company"]', (el) => el.value)) === 'Acme Ltd');
    const progress = await page.$eval('p[role="status"]', (p) => p.textContent);
    check('prefilled required fields count as done, and a prefilled number feeds a formula (1200 × 12)',
      progress === '3 of 4 done' && body.includes('Calculated yearly: 14400.00'), `${progress}`);

    await page.click('input[aria-label^="Text"]', { count: 3 });
    await page.type('input[aria-label^="Text"]', 'Dear Cleo, welcome');
    await page.keyboard.press('Tab');
    await page.click('button[aria-label^="Sign here"]');
    await page.waitForSelector('[role="tablist"]', { visible: true });
    await page.click('[role="tab"]::-p-text(Type)');
    await page.click('button::-p-text(Use this signature)');
    await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await page.click('button::-p-text(Finish)');
    await page.waitForSelector('#finish-title', { visible: true });
    await page.click('button::-p-text(Adopt and Sign)');
    await page.waitForFunction(() => !document.querySelector('#finish-title'), { timeout: 30000 }).catch(() => null);
    const status = (await db.from('recipients').select('status').eq('id', signer.id).single()).data.status;
    const ev = (await db.from('audit_events').select('payload').eq('envelope_id', env.id).eq('event_type', 'fields_prefilled').single()).data;
    check('signing succeeds; one audit event records the 4 prefilled values and the merged note (5 in all)',status === 'signed' && ev?.payload?.fields === 5, `status=${status} fields=${ev?.payload?.fields}`);

    let sealed = null;
    for (let i = 0; i < 60 && !sealed; i++) {
      const { data } = await db.from('envelopes').select('status, sealed_storage_path').eq('id', env.id).single();
      if (data.status === 'completed' && data.sealed_storage_path) sealed = data.sealed_storage_path;
      else await new Promise((r) => setTimeout(r, 2000));
    }
    check('the background worker sealed the document', Boolean(sealed), sealed ? '' : 'is the worker running?');
    if (sealed) {
      const file = Buffer.from(await (await db.storage.from('sealed').download(sealed)).data.arrayBuffer());
      const text = await pdfText(file);
      const want = ['Acme Ltd', 'Dear Cleo, welcome', '1200', '14400.00', merged];
      const missing = want.filter((w) => !text.includes(w));
      check('the sealed PDF shows the locked values, the signer\'s change, the calculated total and the merged note', missing.length === 0, missing.length ? `missing: ${missing.join(' | ')}` : '');
      check('nothing typed over the locked value reached the signed copy', !text.includes('XYZ') && !text.includes('{{'));
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `PREFILL E2E FAILED (${failed} of ${results.length})` : `PREFILL E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`PREFILL E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
