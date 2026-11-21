// npm run e2e:handoff [-- --app http://localhost:3000]
// End-to-end check of delegate and reassign (Phase 4 slice 7, AT4.6, D-83) through the real pages and the real worker:
// * the sender sends with "Let people hand their part to someone else" ticked;
// * Ann, half-way through, hands her part to Dan: she lands on "You handed this document to someone else", her old
//   link no longer opens, Dan's fresh link does, the sender's prefilled value is merged for Dan, and the sender is told;
// * the sender reassigns Cy to Eve on the document page; Cy's link stops working, Eve's works;
// * the audit trail has both handoffs; the document page lists them; the sealed certificate prints them.
// Needs the app AND the background worker running. Synthetic accounts only (fresh password each run, never printed).
// Signs in once (the sign-in limit is 10 per account per 15 minutes).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import { deriveToken } from '../src/lib/signer-token.ts';

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
const tag = randomBytes(3).toString('hex');
const ANN = { name: 'Ann Able', email: `e2e-ann7-${tag}@example.test` };
const CY = { name: 'Cy Clerk', email: `e2e-cy7-${tag}@example.test` };
const DAN = { name: 'Dan Delegate', email: `e2e-dan7-${tag}@example.test` };
const EVE = { name: 'Eve Example', email: `e2e-eve7-${tag}@example.test` };

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
const pageText = (p) => p.evaluate(() => document.body.innerText);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A signer in their own browser profile (the signing session is a cookie). */
async function openLink(browser, token) {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setBypassCSP(true);
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
  return page;
}
async function consent(page) {
  await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
  await page.click('input[name="agree"]');
  await page.click('button::-p-text(Agree and continue)');
  await page.waitForSelector('button[aria-label^="Sign here"]', { timeout: 30000 });
}
async function signAndFinish(page) {
  await page.click('button[aria-label^="Sign here"]');
  await page.waitForSelector('[role="tablist"]', { visible: true });
  await page.click('[role="tab"]::-p-text(Type)');
  await page.click('button::-p-text(Use this signature)');
  await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
  await page.click('button::-p-text(Finish)');
  await page.waitForSelector('#finish-title', { visible: true });
  await page.click('button::-p-text(Adopt and Sign)');
  await page.waitForFunction(() => !document.querySelector('#finish-title'), { timeout: 30000 }).catch(() => null);
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Delegate and reassign end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER, password, email_confirm: true, user_metadata: { full_name: 'Tess Teamowner' } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;

  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Service contract ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(`Service contract ${randomUUID()}`, { x: 72, y: 740, size: 14, font });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'contract.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  await rpc(db, 'set_routing_mode', { p_actor: u.id, p_envelope_id: env.id, p_mode: 'sequential' });
  const saved = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [
    { ...ANN, role: 'signer', routing_order: 1 },
    { ...CY, role: 'signer', routing_order: 2 },
  ] });
  const annId = saved.find((r) => r.email === ANN.email).id;
  const cyId = saved.find((r) => r.email === CY.email).id;
  const f = (rid, type, x, y, extra = {}) => ({ document_id: doc.id, recipient_id: rid, type, page: 1, x, y, w: 0.35, h: 0.035, ...extra });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [
    f(annId, 'text', 0.1, 0.2, { required: false, options: { prefill: 'For {{name}}', readonly: true } }),
    f(annId, 'signature', 0.1, 0.75, { h: 0.07 }),
    f(cyId, 'signature', 0.55, 0.75, { h: 0.07 }),
  ] });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    // ---------- the sender sends with hand-offs allowed ----------
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    await s.click('input[name="allow_delegation"]');
    await s.click('button[name="delivery"][value="link"]');
    let sent = null;
    for (let i = 0; i < 30 && !sent; i++) {
      const { data } = await db.from('envelopes').select('status, allow_delegation').eq('id', env.id).single();
      if (data.status === 'sent') sent = data;
      else await sleep(500);
    }
    check('the sender sends with "Let people hand their part to someone else" ticked', sent?.allow_delegation === true);
    const tokenFor = async (rid) => {
      const links = await rpc(db, 'reveal_signing_links', { p_actor: u.id, p_envelope_id: env.id });
      const { data: rcp } = await db.from('recipients').select('name').eq('id', rid).single();
      const t = links.find((l) => l.recipient_name === rcp.name);
      return deriveToken(process.env.SIGNER_TOKEN_KEY, t.token_id, Buffer.from(t.nonce_hex, 'hex'));
    };

    // ---------- Ann, half-way through, hands her part to Dan ----------
    const annToken = await tokenFor(annId);
    const ann = await openLink(browser, annToken);
    await consent(ann);
    await ann.click('button::-p-text(Hand to someone else)');
    await ann.waitForSelector('#handoff-name', { visible: true });
    await ann.type('#handoff-name', DAN.name);
    await ann.type('#handoff-email', DAN.email);
    await ann.type('#handoff-reason', 'I am on leave; Dan has authority');
    await ann.click('button::-p-text(Hand it over)');
    await ann.waitForFunction(() => document.body.innerText.includes('You handed this document to someone else'), { timeout: 20000 }).catch(() => null);
    check('Ann hands her part to Dan and is told her link no longer works', (await pageText(ann)).includes('You handed this document to someone else'));

    const { data: annTokens } = await db.from('recipient_tokens').select('revoked_at').eq('recipient_id', annId);
    const { data: nowAnnRow } = await db.from('recipients').select('name, email, status').eq('id', annId).single();
    const { data: hand1 } = await db.from('recipient_handoffs').select('by_kind, from_name, to_name, reason').eq('recipient_id', annId).single();
    const { data: ev1 } = await db.from('audit_events').select('payload').eq('envelope_id', env.id).eq('event_type', 'recipient_delegated').single();
    const { data: note } = await db.from('notifications').select('kind').eq('user_id', u.id).eq('kind', 'recipient_delegated').contains('payload', { envelope_id: env.id });
    check('a fresh link replaces the old one, the handoff is recorded and audited, and the sender is told',
      annTokens.filter((t) => t.revoked_at === null).length === 1 && annTokens.length === 2 && nowAnnRow.name === DAN.name && nowAnnRow.email === DAN.email
        && hand1?.by_kind === 'signer' && hand1.from_name === ANN.name && hand1.to_name === DAN.name && hand1.reason === 'I am on leave; Dan has authority'
        && ev1?.payload?.from_name === ANN.name && ev1?.payload?.to_name === DAN.name && (note ?? []).length === 1);

    const old = await openLink(browser, annToken);
    await old.waitForFunction(() => /This link did not open/.test(document.body.innerText), { timeout: 15000 }).catch(() => null);
    check("Ann's old link no longer opens", (await pageText(old)).includes('This link did not open'));

    const dan = await openLink(browser, await tokenFor(annId));
    await consent(dan);
    const danValue = await dan.$eval('input[aria-label^="Text"]', (el) => el.value);
    check("Dan's fresh link opens, with the sender's prefilled value merged for him", danValue === `For ${DAN.name}`, `value="${danValue}"`);
    await signAndFinish(dan);

    // ---------- the sender reassigns Cy to Eve on the document page ----------
    await s.bringToFront();
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    await s.click(`button[aria-label="Correct the name or email of ${CY.name}"]`);
    await s.click('::-p-text(Reassign to someone else)');
    await s.type(`#fix-name-${cyId}`, EVE.name);
    await s.type(`#fix-email-${cyId}`, EVE.email);
    await s.type(`#reassign-reason-${cyId}`, 'Cy has left the company');
    await s.click('button::-p-text(Reassign)');
    await s.waitForFunction((n) => document.body.innerText.includes(`Reassigned to ${n}`), { timeout: 20000 }, EVE.name).catch(() => null);
    const { data: cyTokens } = await db.from('recipient_tokens').select('revoked_at').eq('recipient_id', cyId);
    const { data: hand2 } = await db.from('recipient_handoffs').select('by_kind, from_name, to_name, by_user').eq('recipient_id', cyId).single();
    check('the sender reassigns Cy to Eve: old link revoked, fresh one issued, recorded as the sender\'s',
      (await pageText(s)).includes(`Reassigned to ${EVE.name}`) && cyTokens.filter((t) => t.revoked_at === null).length === 1 && cyTokens.length === 2
        && hand2?.by_kind === 'sender' && hand2.by_user === u.id && hand2.from_name === CY.name && hand2.to_name === EVE.name);
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    const docText = await pageText(s);
    check('the document page lists both handoffs with their reasons',
      docText.includes('Handed over') && docText.includes(`${ANN.name} → ${DAN.name}`) && docText.includes(`${CY.name} → ${EVE.name}`) && docText.includes('Cy has left the company'));

    const eve = await openLink(browser, await tokenFor(cyId));
    await consent(eve);
    await signAndFinish(eve);
    let sealed = null;
    for (let i = 0; i < 60 && !sealed; i++) {
      const { data } = await db.from('envelopes').select('status, sealed_storage_path').eq('id', env.id).single();
      if (data.status === 'completed' && data.sealed_storage_path) sealed = data.sealed_storage_path;
      else await sleep(2000);
    }
    check('the background worker sealed the document', Boolean(sealed), sealed ? '' : 'is the worker running?');
    if (sealed) {
      const file = Buffer.from(await (await db.storage.from('sealed').download(sealed)).data.arrayBuffer());
      const text = await pdfText(file);
      const want = ['Handed over', `${ANN.name} <${ANN.email}> to ${DAN.name}`, `by ${ANN.name}`, 'I am on leave; Dan has authority', `${CY.name} <${CY.email}> to ${EVE.name}`, 'by the sender', 'Cy has left the company', `For ${DAN.name}`];
      const missing = want.filter((w) => !text.includes(w));
      check('the certificate prints both handoffs (who, to whom, by whom, why); the merged value is on the document', missing.length === 0, missing.length ? `missing: ${missing.join(' | ')}` : '');
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `HANDOFF E2E FAILED (${failed} of ${results.length})` : `HANDOFF E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`HANDOFF E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
