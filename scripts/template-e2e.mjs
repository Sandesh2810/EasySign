// npm run e2e:templates [-- --app http://localhost:3000]
// End-to-end check of templates through the real pages (Phase 4 slice 2, AT4.1, D-77):
// save a document as a template -> lock a field on the template page -> use the template to start a draft ->
// the locked field shows as locked and does not move -> the draft has its own copy of the file -> deleting the template
// leaves the draft alone. Synthetic account team-owner@example.test (fresh password each run, never printed).
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

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Template end-to-end check against ${APP}`);
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

  // a real two-page draft with a Tenant (signature) and a Landlord (signature)
  const stamp = randomBytes(3).toString('hex');
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `E2E lease ${stamp}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const t of ['Lease page 1', 'Lease page 2']) pdf.addPage([612, 792]).drawText(`${t} ${randomUUID()}`, { x: 72, y: 700, size: 14, font });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'lease.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 2, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const people = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [
    { name: 'Tia Tenant', email: 'e2e-tia@example.test', role: 'signer', routing_order: 1 },
    { name: 'Leo Landlord', email: 'e2e-leo@example.test', role: 'signer', routing_order: 2 }] });
  const [ten, land] = [people.find((p) => p.routing_order === 1), people.find((p) => p.routing_order === 2)];
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [
    { document_id: doc.id, recipient_id: ten.id, type: 'signature', page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
    { document_id: doc.id, recipient_id: land.id, type: 'signature', page: 2, x: 0.55, y: 0.8, w: 0.3, h: 0.06 }] });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 1280, height: 900 });
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await page.type('#email', OWNER);
    await page.type('#password', password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('form button[type="submit"]')]);

    // 1. save as template on the document page
    await page.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    const tplName = `E2E lease template ${stamp}`;
    await page.click('#tpl-new-name', { count: 3 });
    await page.type('#tpl-new-name', tplName);
    await page.type(`#label-${ten.id}`, 'Tenant');
    await page.type(`#label-${land.id}`, 'Landlord');
    await page.click('button::-p-text(Save as template)');
    await page.waitForFunction(() => /saved\. Find it under Templates/.test(document.body.innerText), { timeout: 30000 });
    const { data: tpl } = await db.from('templates').select('id, storage_path').eq('org_id', org).eq('name', tplName).single();
    check('a document is saved as a template from its page, with roles instead of people', Boolean(tpl?.id));

    // 2. lock the Tenant's signature on the template page
    await page.goto(`${APP}/app/templates/${tpl.id}`, { waitUntil: 'networkidle0' });
    const lockBox = await page.$('::-p-text(Signature · Tenant · page 2)');
    await lockBox.click();
    await page.click('button::-p-text(Save template)');
    await page.waitForFunction(() => /Template saved\./.test(document.body.innerText), { timeout: 20000 });
    const { count: lockedCount } = await db.from('template_fields').select('id', { count: 'exact', head: true }).eq('template_id', tpl.id).eq('locked', true);
    check('a field is locked on the template page', lockedCount === 1);

    // 3. use the template
    const { data: roles } = await db.from('template_roles').select('id, label').eq('template_id', tpl.id);
    for (const r of roles) {
      await page.type(`#name-${r.id}`, r.label === 'Tenant' ? 'Tom Tenant' : 'Lara Landlord');
      await page.type(`#email-${r.id}`, r.label === 'Tenant' ? 'e2e-tom@example.test' : 'e2e-lara@example.test');
    }
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('button::-p-text(Create draft)')]);
    const newId = page.url().split('/app/envelopes/')[1]?.split(/[?#]/)[0];
    check('using the template opens a new draft', Boolean(newId) && newId !== env.id);
    await page.waitForSelector('[aria-label^="Signature · Tom Tenant · locked"]', { timeout: 20000 }).catch(() => null);
    const locked = await page.$('[aria-label^="Signature · Tom Tenant · locked"]');
    check('the locked field shows as locked in the draft', Boolean(locked));
    const { data: before } = await db.from('fields').select('x, y, locked').eq('envelope_id', newId).eq('locked', true).single();
    await locked.click();
    const toolbar = await page.evaluate(() => document.body.innerText);
    check('selecting it says it is fixed and offers no Move or Remove buttons', /fixed by the template/.test(toolbar) && !(await page.$('button[aria-label="Move right"]')) && !(await page.$('button::-p-text(Remove)')));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    const { data: after } = await db.from('fields').select('x, y, locked').eq('envelope_id', newId).eq('locked', true).maybeSingle();
    check('arrow keys and Delete do not move or remove it', Boolean(after) && Number(after.x) === Number(before.x) && Number(after.y) === Number(before.y));

    // 4. the draft has its own copy of the file
    const { data: newDoc } = await db.from('envelope_documents').select('storage_path, sha256').eq('envelope_id', newId).single();
    const copy = Buffer.from(await (await db.storage.from('originals').download(newDoc.storage_path)).data.arrayBuffer());
    check('the draft has its own copy of the document, identical to the original', newDoc.storage_path === `${org}/${newId}/document.pdf` && newDoc.storage_path !== tpl.storage_path && sha(copy) === newDoc.sha256 && newDoc.sha256 === sha(bytes));

    // 5. deleting the template leaves the draft alone
    const { count: fieldsBefore } = await db.from('fields').select('id', { count: 'exact', head: true }).eq('envelope_id', newId);
    await page.goto(`${APP}/app/templates/${tpl.id}`, { waitUntil: 'networkidle0' });
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('button::-p-text(Delete this template)')]);
    const { data: gone } = await db.from('templates').select('deleted_at').eq('id', tpl.id).single();
    const { count: fieldsAfter } = await db.from('fields').select('id', { count: 'exact', head: true }).eq('envelope_id', newId);
    const stillThere = await db.storage.from('originals').download(newDoc.storage_path);
    const tplFile = await db.storage.from('originals').download(tpl.storage_path);
    check('deleting the template removes it and its file, and leaves the draft and its file untouched',
      Boolean(gone?.deleted_at) && fieldsAfter === fieldsBefore && !stillThere.error && Boolean(tplFile.error));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `TEMPLATE E2E FAILED (${failed} of ${results.length})` : `TEMPLATE E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`TEMPLATE E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
