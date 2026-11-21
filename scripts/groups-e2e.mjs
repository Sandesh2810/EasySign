// npm run e2e:groups [-- --app http://localhost:3000]
// End-to-end check of signing groups (Phase 4 slice 6, AT4.5, D-81) through the real pages and the real worker:
// * the field editor shows the group once; fields placed for the group are copied to every member when sending, even in
//   "one after another" order;
// * both members open the document; the first to sign completes the group; the other is told who signed (also when
//   they were half-way through) and sees "Already completed"; the audit trail records who;
// * the next person signs; the sealed PDF carries the signing member's answers only and the certificate says who signed
//   for the group.
// Needs the app AND the background worker running. Synthetic accounts only (fresh password each run, never printed).
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
const ANN = { name: 'Ann Able', email: `e2e-ann-${tag}@example.test` };
const BEN = { name: 'Ben Bold', email: `e2e-ben-${tag}@example.test` };
const CY = { name: 'Cy Clerk', email: `e2e-cy-${tag}@example.test` };

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

async function openAndConsent(browser, token) {
  // each signer in their own browser profile: the signing session is a cookie, and Ann and Ben are different people
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setBypassCSP(true);
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
  await page.click('input[name="agree"]');
  await page.click('button::-p-text(Agree and continue)');
  await page.waitForSelector('button[aria-label^="Sign here"]', { timeout: 30000 });
  return page;
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
  console.log(`Signing groups end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER, password, email_confirm: true, user_metadata: { full_name: 'Tess Teamowner' } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;

  // a draft: Ann and Ben in the "Finance" group (turn 1), then Cy (turn 2), "one after another"
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Board resolution ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(`Board resolution ${randomUUID()}`, { x: 72, y: 740, size: 14, font });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'board.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  await rpc(db, 'set_routing_mode', { p_actor: u.id, p_envelope_id: env.id, p_mode: 'sequential' });
  const saved = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [
    { ...ANN, role: 'signer', routing_order: 1, signing_group: 'Finance' },
    { ...BEN, role: 'signer', routing_order: 1, signing_group: 'Finance' },
    { ...CY, role: 'signer', routing_order: 2 },
  ] });
  const idOf = (p) => saved.find((r) => r.email === p.email).id;
  // the fields as the editor saves them: for the group (its first member, Ann) and for Cy; Ben gets his copy at sending
  const f = (rid, type, y, extra = {}) => ({ document_id: doc.id, recipient_id: rid, type, page: 1, x: 0.1, y, w: 0.35, h: 0.035, ...extra });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [
    f(idOf(ANN), 'text', 0.2, { required: true, options: { name: 'po' } }),
    f(idOf(ANN), 'signature', 0.7, { h: 0.07 }),
    { ...f(idOf(CY), 'signature', 0.85, { h: 0.07 }), x: 0.55 },
  ] });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    // ---------- the sender: the group shown once; sending copies the group's fields ----------
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    const draftText = await pageText(s);
    // members saved together share a creation time, so they may be listed in either order
    check('the field editor shows the signing group once, with its members', /Finance \(group: (Ann Able, Ben Bold|Ben Bold, Ann Able)\)/.test(draftText));
    await s.click('button[name="delivery"][value="link"]');
    let sent = false;
    for (let i = 0; i < 30 && !sent; i++) {
      sent = (await db.from('envelopes').select('status').eq('id', env.id).single()).data.status === 'sent';
      if (!sent) await new Promise((r) => setTimeout(r, 500));
    }
    const benFields = (await db.from('fields').select('type').eq('recipient_id', idOf(BEN))).data ?? [];
    const statuses = Object.fromEntries(((await db.from('recipients').select('email, status').eq('envelope_id', env.id)).data ?? []).map((r) => [r.email, r.status]));
    check('sent "one after another": Ben got a copy of the group\'s fields, and both members are in turn together',
      sent && benFields.map((x) => x.type).sort().join(',') === 'signature,text' && statuses[ANN.email] === 'sent' && statuses[BEN.email] === 'sent' && statuses[CY.email] === 'created',
      `sent=${sent} ben=${benFields.map((x) => x.type).join('+')}`);

    const links = await rpc(db, 'reveal_signing_links', { p_actor: u.id, p_envelope_id: env.id });
    const tokenOf = (name) => {
      const t = links.find((l) => l.recipient_name === name);
      return deriveToken(process.env.SIGNER_TOKEN_KEY, t.token_id, Buffer.from(t.nonce_hex, 'hex'));
    };

    // ---------- both members open it; Ben starts, Ann finishes first ----------
    const ben = await openAndConsent(browser, tokenOf(BEN.name));
    await ben.type('input[aria-label^="Text"]', 'PO-BEN');
    await ben.keyboard.press('Tab');
    const ann = await openAndConsent(browser, tokenOf(ANN.name));
    await ann.bringToFront(); // headless Chrome can stall scripted actions in a background tab
    await ann.type('input[aria-label^="Text"]', 'PO-ANN');
    await ann.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 800));
    await signAndFinish(ann);
    const after = Object.fromEntries(((await db.from('recipients').select('email, status, group_completed_by').eq('envelope_id', env.id)).data ?? []).map((r) => [r.email, r]));
    const ev = (await db.from('audit_events').select('payload').eq('envelope_id', env.id).eq('event_type', 'group_completed').single()).data;
    check('the first member to sign completes the group: Ann signed, Ben no longer needed, Cy is in turn; the audit trail records who',
      after[ANN.email].status === 'signed' && after[BEN.email].status === 'skipped' && after[BEN.email].group_completed_by === idOf(ANN) && after[CY.email].status === 'sent'
        && ev?.payload?.by === idOf(ANN) && JSON.stringify(ev?.payload?.no_longer_needed) === JSON.stringify([idOf(BEN)]));

    // Ben, still on the page, tries to change his answer: he is told who signed
    await ben.bringToFront();
    await ben.click('input[aria-label^="Text"]', { count: 3 });
    await ben.type('input[aria-label^="Text"]', 'PO-BEN-2');
    await ben.keyboard.press('Tab');
    await ben.waitForFunction(() => document.body.innerText.includes('already signed for your signing group'), { timeout: 10000 }).catch(() => null);
    check('the other member, half-way through, is told who signed for the group', (await pageText(ben)).includes('Ann Able has already signed for your signing group'));
    await ben.reload({ waitUntil: 'networkidle0' });
    const benNow = await pageText(ben);
    check('opening the link again shows "Already completed" with who signed, and nothing to do', benNow.includes('Already completed') && benNow.includes('Ann Able signed') && benNow.includes('Nothing more is needed from you'));

    await s.bringToFront();
    await s.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    check("the sender's page says Ben was not needed because Ann signed for the group", (await pageText(s)).includes('Not needed: Ann Able signed for the group'));

    // ---------- Cy signs; the document is sealed ----------
    const cy = await openAndConsent(browser, tokenOf(CY.name));
    await cy.bringToFront();
    await signAndFinish(cy);
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
      check("the sealed PDF carries Ann's answer, not Ben's unfinished one", text.includes('PO-ANN') && !text.includes('PO-BEN'));
      check('the certificate says Ben was not needed because Ann signed for the group', text.includes('not needed: Ann Able signed for the group'));
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `GROUPS E2E FAILED (${failed} of ${results.length})` : `GROUPS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`GROUPS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
