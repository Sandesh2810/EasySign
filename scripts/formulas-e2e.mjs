// npm run e2e:formulas [-- --app http://localhost:3000]
// End-to-end check of formulas and conditions (Phase 4 slice 4, AT4.4, D-79) through the real pages and the real worker:
// * sending a document whose formula names a field that does not exist is refused with a plain reason; fixed, it sends;
// * the signer types a quantity and a price and sees the total, VAT and grand total update live, to the cent;
// * ticking a box shows a required field (and counts it), unticking hides it again; a value typed into it before it was
//   hidden is ignored: signing succeeds, the hidden field is recorded in the signing event, and the sealed PDF leaves it out
//   while printing the calculated amounts.
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
const SECRET = `HIDDEN-${randomBytes(3).toString('hex').toUpperCase()}`;
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

/** A draft with one signer and one uploaded page; returns ids. */
async function draft(db, u, org, title) {
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `${title} ${randomBytes(3).toString('hex')}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(`${title} ${randomUUID()}`, { x: 72, y: 740, size: 14, font });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'quote.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [signer] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Quinn Quote', email: 'e2e-quinn@example.test', role: 'signer', routing_order: 1 }] });
  const f = (type, y, extra = {}) => ({ document_id: doc.id, recipient_id: signer.id, type, page: 1, x: 0.1, y, w: 0.35, h: 0.035, ...extra });
  return { env, signer, f };
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Formulas and conditions end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER, password, email_confirm: true, user_metadata: { full_name: 'Tess Teamowner' } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    // ---------- 1. the send action refuses a formula that names a missing field ----------
    const b = await draft(db, u, org, 'Broken quote');
    const brokenFields = (formula) => [
      b.f('number', 0.1, { options: { name: 'qty', decimals: 0 } }),
      b.f('formula', 0.2, { required: false, options: { formula } }),
      b.f('signature', 0.8, { h: 0.07 }),
    ];
    await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: b.env.id, p_fields: brokenFields('qty * pricee') });
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);
    await s.goto(`${APP}/app/envelopes/${b.env.id}`, { waitUntil: 'networkidle0' });
    await s.click('button[name="delivery"][value="link"]');
    await s.waitForFunction(() => document.body.innerText.includes('Not ready to send.'), { timeout: 20000 }).catch(() => null);
    const said = await s.evaluate(() => document.body.innerText);
    const stillDraft = (await db.from('envelopes').select('status').eq('id', b.env.id).single()).data.status === 'draft';
    check('sending is refused, in plain words, when a formula names a field that does not exist', stillDraft && said.includes('No field is named "pricee"'));
    await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: b.env.id, p_fields: brokenFields('qty * 2') });
    await s.goto(`${APP}/app/envelopes/${b.env.id}`, { waitUntil: 'networkidle0' });
    await s.click('button[name="delivery"][value="link"]');
    let sent = false;
    for (let i = 0; i < 20 && !sent; i++) {
      sent = (await db.from('envelopes').select('status').eq('id', b.env.id).single()).data.status === 'sent';
      if (!sent) await new Promise((r) => setTimeout(r, 500));
    }
    check('once the formula is corrected, it sends', sent);
    await rpc(db, 'void_envelope', { p_actor: u.id, p_envelope_id: b.env.id, p_reason: 'e2e check finished' }).catch(() => null);

    // ---------- 2. the signer: live totals and a condition ----------
    const q = await draft(db, u, org, 'Quote');
    await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: q.env.id, p_fields: [
      q.f('number', 0.1, { options: { name: 'qty', decimals: 0 } }),
      q.f('number', 0.15, { options: { name: 'unit_price', decimals: 2 } }),
      q.f('formula', 0.2, { required: false, options: { name: 'net', formula: 'qty * unit_price' } }),
      q.f('formula', 0.25, { required: false, options: { name: 'vat', formula: 'round(net * 0.2, 2)' } }),
      q.f('formula', 0.3, { required: false, options: { name: 'grand_total', formula: 'net + vat' } }),
      q.f('checkbox', 0.4, { w: 0.03, h: 0.022, required: false, options: { name: 'rush' } }),
      q.f('text', 0.45, { required: true, options: { show_if: 'rush' } }),
      q.f('signature', 0.8, { h: 0.07 }),
    ] });
    const hiddenId = (await db.from('fields').select('id').eq('envelope_id', q.env.id).eq('type', 'text').single()).data.id;
    const tokenId = randomUUID();
    const nonce = newNonce();
    const token = deriveToken(process.env.SIGNER_TOKEN_KEY, tokenId, nonce);
    await rpc(db, 'send_envelope', { p_actor: u.id, p_envelope_id: q.env.id, p_tokens: [{ recipient_id: q.signer.id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
      p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link' });

    const page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await page.click('input[name="agree"]');
    await page.click('button::-p-text(Agree and continue)');
    await page.waitForSelector('input[aria-label^="Number"]', { timeout: 30000 });
    const body = () => page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
    // centred first: the sticky top bar must not be over the small box when it is clicked
    const clickBox = async () => {
      const el = await page.$('input[type="checkbox"][aria-label^="Checkbox"]');
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await el.click();
    };
    const progress = () => page.$eval('p[role="status"]', (p) => p.textContent);

    const textHidden = (await page.$('input[aria-label^="Text"]')) === null;
    check('the field with a condition starts hidden and is not counted', textHidden && (await progress()) === '0 of 3 done', await progress());

    const nums = await page.$$('input[aria-label^="Number"]');
    await nums[0].type('3');
    await nums[1].type('19.99'); // no Tab: the totals follow each key press
    await page.waitForFunction(() => document.body.textContent.replace(/\s+/g, ' ').includes('Calculated grand total: 71.96'), { timeout: 5000 }).catch(() => null);
    const t = await body();
    check('totals update live as the signer types, to the cent (59.97 + VAT 11.99 = 71.96)',
      t.includes('Calculated net: 59.97') && t.includes('Calculated vat: 11.99') && t.includes('Calculated grand total: 71.96'));
    await page.keyboard.press('Tab');

    await clickBox();
    await page.waitForSelector('input[aria-label^="Text"]', { timeout: 5000 }).catch(() => null);
    const shownNow = (await page.$('input[aria-label^="Text"]')) !== null;
    check('ticking the box shows the required field and counts it', shownNow && /of 4 done$/.test(await progress()), await progress());
    if (shownNow) {
      await page.type('input[aria-label^="Text"]', SECRET);
      await page.keyboard.press('Tab'); // the typed value is saved on leaving the field
    }
    // untick at once, without waiting for the saves before it to come back (a quick tick-untick must still be stored)
    await clickBox();
    await page.waitForFunction(() => !document.querySelector('input[aria-label^="Text"]'), { timeout: 5000 }).catch(() => null);
    const goneNow = (await page.$('input[aria-label^="Text"]')) === null;
    const boxId = (await db.from('fields').select('id').eq('envelope_id', q.env.id).eq('type', 'checkbox').single()).data.id;
    let storedSecret = null;
    let boxStored = 'true';
    for (let i = 0; i < 40 && (storedSecret !== SECRET || boxStored !== null); i++) {
      await new Promise((r) => setTimeout(r, 500));
      storedSecret = (await db.from('field_values').select('value_text').eq('field_id', hiddenId).maybeSingle()).data?.value_text ?? null;
      boxStored = (await db.from('field_values').select('value_text').eq('field_id', boxId).maybeSingle()).data?.value_text ?? null;
    }
    check('unticking hides it again and the untick is stored; the value typed into the hidden field stays stored (and must not count)',
      goneNow && boxStored === null && storedSecret === SECRET, `gone=${goneNow} box=${boxStored} typed-value-stored=${storedSecret === SECRET}`);

    await page.click('button[aria-label^="Sign here"]');
    await page.waitForSelector('[role="tablist"]', { visible: true });
    await page.click('[role="tab"]::-p-text(Type)');
    await page.click('button::-p-text(Use this signature)');
    await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await page.click('button::-p-text(Finish)');
    await page.waitForSelector('#finish-title', { visible: true });
    await page.click('button::-p-text(Adopt and Sign)');
    await page.waitForFunction(() => !document.querySelector('#finish-title'), { timeout: 30000 }).catch(() => null);
    const status = (await db.from('recipients').select('status').eq('id', q.signer.id).single()).data.status;
    const ev = (await db.from('audit_events').select('payload').eq('envelope_id', q.env.id).eq('event_type', 'recipient_signed').order('seq', { ascending: false }).limit(1).single()).data;
    check('signing succeeds with the required field hidden, and the signing event records it as hidden',
      status === 'signed' && JSON.stringify(ev?.payload?.hidden_fields) === JSON.stringify([hiddenId]), `status=${status}`);

    let sealed = null;
    for (let i = 0; i < 60 && !sealed; i++) {
      const { data } = await db.from('envelopes').select('status, sealed_storage_path').eq('id', q.env.id).single();
      if (data.status === 'completed' && data.sealed_storage_path) sealed = data.sealed_storage_path;
      else await new Promise((r) => setTimeout(r, 2000));
    }
    check('the background worker sealed the document', Boolean(sealed), sealed ? '' : 'is the worker running?');
    if (sealed) {
      const file = Buffer.from(await (await db.storage.from('sealed').download(sealed)).data.arrayBuffer());
      const text = await pdfText(file);
      const missing = ['59.97', '11.99', '71.96'].filter((w) => !text.includes(w));
      check('the sealed PDF prints the calculated amounts', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
      check('the sealed PDF leaves out the hidden field and what was typed into it', !text.includes(SECRET));
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `FORMULAS E2E FAILED (${failed} of ${results.length})` : `FORMULAS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`FORMULAS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
