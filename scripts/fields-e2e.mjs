// npm run e2e:fields [-- --app http://localhost:3000]
// End-to-end check of the new field types (Phase 4 slice 3, D-78) through the real signer page and the real worker:
// a signer fills a checkbox, a choice, a dropdown, a number and a checked text field (a wrong value shows the sender's
// own message), sees a note and a link, attaches a file, signs -> the worker seals it -> the sealed PDF shows every value
// -> the sender downloads the attached file unchanged. Needs the app AND the background worker running.
// Synthetic accounts only (fresh password each run, never printed). Uses the Chrome installed on this PC.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const NOTE = 'Payment is due within 30 days of the invoice.';

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
  console.log(`Field types end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER, password, email_confirm: true, user_metadata: { full_name: 'Tess Teamowner' } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  // 'trusted': keeps this synthetic account out of the small daily email pool that new accounts share
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;

  // the document: every new type for one signer
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Order form ${randomBytes(3).toString('hex')}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(`Order form ${randomUUID()}`, { x: 72, y: 740, size: 14, font });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'order.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [signer] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Cleo Client', email: 'e2e-cleo@example.test', role: 'signer', routing_order: 1 }] });
  const f = (type, y, extra = {}) => ({ document_id: doc.id, recipient_id: signer.id, type, page: 1, x: 0.1, y, w: 0.4, h: 0.035, ...extra });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [
    f('checkbox', 0.1, { w: 0.03, h: 0.022, required: true }),
    f('radio', 0.15, { h: 0.08, options: { choices: ['Monthly', 'Yearly'] } }),
    f('dropdown', 0.25, { options: { choices: ['Red', 'Green', 'Blue'] } }),
    f('number', 0.3, { options: { min: 0, max: 1000, decimals: 2 } }),
    f('text', 0.35, { options: { check: 'custom', pattern: '^[A-Z]{2}[0-9]{4}$', message: 'Use the policy number, like AB1234' } }),
    f('note', 0.4, { h: 0.05, required: false, options: { text: NOTE } }),
    f('hyperlink', 0.47, { required: false, options: { url: 'https://example.com/terms', label: 'Our terms' } }),
    f('attachment', 0.52, { required: true }),
    f('signature', 0.8, { h: 0.07 }),
  ] });
  const tokenId = randomUUID();
  const nonce = newNonce();
  const token = deriveToken(process.env.SIGNER_TOKEN_KEY, tokenId, nonce);
  await rpc(db, 'send_envelope', { p_actor: u.id, p_envelope_id: env.id, p_tokens: [{ recipient_id: signer.id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
    p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link' });

  // a small PDF to attach
  const att = await PDFDocument.create();
  att.addPage([300, 200]).drawText('Proof of address', { x: 20, y: 100, size: 12, font: await att.embedFont(StandardFonts.Helvetica) });
  const attBytes = await att.save();
  const attPath = path.join(mkdtempSync(path.join(tmpdir(), 'ynms-e2e-')), 'Proof of address.pdf');
  writeFileSync(attPath, attBytes);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await page.click('input[name="agree"]');
    await page.click('button::-p-text(Agree and continue)');
    await page.waitForSelector('input[type="checkbox"][aria-label^="Checkbox"]', { timeout: 30000 });

    const roomText = await page.evaluate(() => document.body.innerText);
    const link = await page.$eval('a[target="_blank"][href="https://example.com/terms"]', (a) => a.rel).catch(() => null);
    check('the signer sees the note and a link that opens safely in a new tab', roomText.includes(NOTE) && link === 'noopener noreferrer');

    await page.type('input[aria-label^="Text"]', 'ab1234');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.body.innerText.includes('Use the policy number, like AB1234'), { timeout: 10000 }).catch(() => null);
    const invalid = await page.$eval('input[aria-label^="Text"]', (el) => el.getAttribute('aria-invalid'));
    check("a wrong value shows the sender's own message and marks the field invalid", (await page.evaluate(() => document.body.innerText)).includes('Use the policy number, like AB1234') && invalid === 'true');
    await page.click('input[aria-label^="Text"]', { count: 3 });
    await page.type('input[aria-label^="Text"]', 'AB1234');
    await page.keyboard.press('Tab');

    await page.click('input[type="checkbox"][aria-label^="Checkbox"]');
    await page.click('input[type="radio"][value="Yearly"]');
    await page.select('select[aria-label^="Dropdown"]', 'Green');
    await page.type('input[aria-label^="Number"]', '249.99');
    await page.keyboard.press('Tab');
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(attPath);
    await page.waitForFunction(() => /Attached: Proof of address\.pdf/.test(document.body.innerText), { timeout: 30000 });
    check('the signer attaches a file and sees its name', true);

    await page.click('button[aria-label^="Sign here"]');
    await page.waitForSelector('[role="tablist"]', { visible: true });
    await page.click('[role="tab"]::-p-text(Type)');
    await page.click('button::-p-text(Use this signature)');
    await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await page.click('button::-p-text(Finish)');
    await page.waitForSelector('#finish-title', { visible: true });
    await page.click('button::-p-text(Adopt and Sign)');
    await page.waitForFunction(() => !document.querySelector('#finish-title'), { timeout: 30000 });

    const stored = (await db.from('field_values').select('value_text, fields!inner(type)').eq('envelope_id', env.id)).data ?? [];
    const byType = Object.fromEntries(stored.map((r) => [r.fields.type, r.value_text]));
    check('every value reached the database as given', byType.checkbox === 'true' && byType.radio === 'Yearly' && byType.dropdown === 'Green' && byType.number === '249.99' && byType.text === 'AB1234' && /^Proof of address\.pdf · SHA-256 [0-9a-f]{16}$/.test(byType.attachment ?? ''));

    // the worker seals it
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
      const want = ['Yearly', 'Green', '249.99', 'AB1234', 'Payment is due within 30 days', 'Our terms (https://example.com/terms)', 'Proof of address.pdf · SHA-256'];
      const missing = want.filter((w) => !text.includes(w));
      check('the sealed PDF shows the choice, dropdown, number, text, note, link and the attachment\'s name and fingerprint', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
    }

    // the sender downloads the attached file
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    const href = await s.$eval('a[download]', (a) => a.getAttribute('href')).catch(() => null);
    const got = href ? await s.evaluate(async (h) => { const r = await fetch(h); return { status: r.status, bytes: Array.from(new Uint8Array(await r.arrayBuffer())) }; }, href) : null;
    check('the sender sees "Files attached by signers" and downloads the file unchanged', Boolean(got) && got.status === 200 && sha(Uint8Array.from(got.bytes)) === sha(attBytes));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `FIELDS E2E FAILED (${failed} of ${results.length})` : `FIELDS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`FIELDS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
