// npm run e2e:forms [-- --app http://localhost:3000]
// End-to-end check of public forms / PowerForms (Phase 4 slice 11, AT4.3, D-87) through the real pages and the real worker:
// * the owner creates a public form on a one-person template (title, daily limit), copies its link, pauses and resumes it;
// * a visitor opens the link, sees who it is from, is refused when sending too fast or when the hidden trap field is
//   filled, then gets their own document and signs it; it is recorded as made from the form;
// * 20 visitors submitting at the same moment get 20 distinct documents, each for its own person;
// * the next visitor is refused: the form has reached its daily limit.
// Needs the app AND the background worker running. Synthetic accounts only. Signs in once. Uses up to 22 of the
// 30-per-10-minutes allowance of form submissions from this computer's address: wait 10 minutes before running it again.
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
const OWNER = { email: 'forms-owner@example.test', name: 'Fran Forms' };
const CROWD = 20;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const tag = randomBytes(3).toString('hex');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageText = (p) => p.evaluate(() => document.body.innerText);

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

/** A one-person template ("Volunteer", one signature), made the way "Save as template" makes it. */
async function makeTemplate(db, u, org) {
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Waiver source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Volunteer waiver ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'waiver.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Volunteer', email: `e2e-vol-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  const copied = await db.storage.from('originals').copy(srcPath, tplPath);
  if (copied.error) throw new Error(`template copy: ${copied.error.message}`);
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `Volunteer waiver ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Volunteer' }], p_storage_path: tplPath });
  return templateId;
}

/** A visitor in their own browser profile: opens the form, fills it in, and (unless told otherwise) waits like a person. */
async function visitor(browser, link, who, { wait = 3500, trap = null } = {}) {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setBypassCSP(true);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(link, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#pf-name', { timeout: 30000 });
  await page.type('#pf-name', who.name);
  await page.type('#pf-email', who.email);
  if (trap) await page.type('#pf-website', trap);
  if (wait) await sleep(wait);
  return page;
}
const send = async (page) => {
  await page.click('button::-p-text(Continue to sign)');
  await page.waitForFunction(() => location.pathname === '/sign' || document.querySelector('[role="alert"]'), { timeout: 60000 }).catch(() => null);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 20000 }).catch(() => null);
};

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Public forms (PowerForms) end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password, email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 200, daily_recipient_cap: 200 }).eq('user_id', u.id);
  await db.from('profiles').update({ display_name: OWNER.name }).eq('id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const templateId = await makeTemplate(db, u, m.org_id);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const owner = await browser.newPage();
    await owner.setBypassCSP(true);
    await owner.setViewport({ width: 1280, height: 1000 });
    await owner.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await owner.type('#email', OWNER.email);
    await owner.type('#password', password);
    await Promise.all([owner.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), owner.click('form button[type="submit"]')]);

    // ---------- the owner creates the form ----------
    await owner.goto(`${APP}/app/templates/${templateId}`, { waitUntil: 'networkidle0' });
    await owner.click('#pf-title', { count: 3 });
    await owner.type('#pf-title', `Volunteer sign-up ${tag}`);
    await owner.click('#pf-limit', { count: 3 });
    await owner.type('#pf-limit', String(CROWD + 1));
    await owner.click('button::-p-text(Create a public form)');
    await owner.waitForFunction(() => /\/f\/[A-Za-z0-9_-]{22}/.test(document.body.innerText), { timeout: 20000 });
    const link = (await pageText(owner)).match(/https?:\/\/\S+\/f\/[A-Za-z0-9_-]{22}/)?.[0];
    const { data: form } = await db.from('power_forms').select('id, slug, daily_limit, status').eq('template_id', templateId).single();
    check('the owner creates a public form on a one-person template and sees its link', Boolean(link) && link.endsWith(`/f/${form?.slug}`) && form?.daily_limit === CROWD + 1);

    // ---------- pause and resume ----------
    await owner.click('button::-p-text(Pause)');
    await owner.waitForFunction(() => document.body.innerText.includes('paused'), { timeout: 15000 });
    const closed = await (await browser.createBrowserContext()).newPage();
    await closed.goto(link, { waitUntil: 'networkidle0' });
    const closedText = await pageText(closed);
    await closed.close();
    await owner.click('button::-p-text(Resume)');
    await owner.waitForFunction(() => document.body.innerText.includes('taking submissions'), { timeout: 15000 });
    check('a paused form shows "not available"; resumed, it is open again', closedText.includes('This form is not available'));

    // ---------- one visitor: refused when too fast or when the trap is filled, then signs their own copy ----------
    const ann = { name: `Ann Visitor ${tag}`, email: `e2e-ann-${tag}@example.test` };
    const hurried = await visitor(browser, link, ann, { wait: 0 });
    const shown = await pageText(hurried);
    await send(hurried);
    const hurriedText = await pageText(hurried);
    await hurried.close();
    check('the form says who it is from; sending faster than a person could is refused', shown.includes(`From ${OWNER.name}`) && hurriedText.includes('take a moment'));
    const bot = await visitor(browser, link, { name: 'Bot', email: `e2e-bot-${tag}@example.test` }, { trap: 'http://spam.example' });
    await send(bot);
    const botText = await pageText(bot);
    await bot.close();
    const { count: afterRefusals } = await db.from('power_form_submissions').select('id', { count: 'exact', head: true }).eq('form_id', form.id);
    check('a filled-in trap field is refused, and refused attempts make nothing', botText.includes('could not be accepted') && afterRefusals === 0);

    const page = await visitor(browser, link, ann);
    await send(page);
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    const consentText = await pageText(page);
    await page.click('input[name="agree"]');
    await page.click('button::-p-text(Agree and continue)');
    await page.waitForSelector('button[aria-label^="Sign here"]', { timeout: 30000 });
    await page.click('button[aria-label^="Sign here"]');
    await page.waitForSelector('[role="tablist"]', { visible: true });
    await page.click('[role="tab"]::-p-text(Type)');
    await page.click('button::-p-text(Use this signature)');
    await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await page.click('button::-p-text(Finish)');
    await page.waitForSelector('#finish-title', { visible: true });
    await page.click('button::-p-text(Adopt and Sign)');
    const { data: annSub } = await db.from('power_form_submissions').select('envelope_id, status').eq('form_id', form.id).single();
    let annEnv = null;
    for (let i = 0; i < 60 && !annEnv?.sealed_storage_path; i++) {
      annEnv = (await db.from('envelopes').select('id, status, sender_id, sealed_storage_path').eq('id', annSub.envelope_id).single()).data;
      if (!annEnv?.sealed_storage_path) await sleep(2000);
    }
    const { data: annPeople } = await db.from('recipients').select('name, email, status').eq('envelope_id', annSub.envelope_id);
    const { data: annAudit } = await db.from('audit_events').select('event_type').eq('envelope_id', annSub.envelope_id).eq('event_type', 'created_from_public_form');
    check('the visitor gets their own document from the template, signs it, and it is sealed; it is recorded as made from the form',
      consentText.includes(`I am ${ann.name}`) && annSub.status === 'sent' && annEnv?.sender_id === u.id && annEnv?.status === 'completed' && Boolean(annEnv?.sealed_storage_path)
        && annPeople?.length === 1 && annPeople[0].email === ann.email && annPeople[0].status === 'signed' && (annAudit ?? []).length === 1);
    await page.close();

    // ---------- 20 visitors at the same moment ----------
    const crowd = Array.from({ length: CROWD }, (_, i) => ({ name: `Crowd ${i + 1} ${tag}`, email: `e2e-crowd${i + 1}-${tag}@example.test` }));
    // the pages are opened one after another (the development server builds pages slowly); the 20 submissions then go at once
    const pages = [];
    for (const who of crowd) pages.push(await visitor(browser, link, who, { wait: 0 }));
    await sleep(3500);
    const t0 = Date.now();
    await Promise.all(pages.map((p) => send(p)));
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const landed = await Promise.all(pages.map(async (p, i) => p.url().endsWith('/sign') && (await pageText(p)).includes(`I am ${crowd[i].name}`)));
    const { data: subs } = await db.from('power_form_submissions').select('envelope_id, status').eq('form_id', form.id).eq('status', 'sent');
    const envIds = (subs ?? []).map((s) => s.envelope_id);
    const { data: people } = await db.from('recipients').select('envelope_id, email').in('envelope_id', envIds);
    const perEnvelope = new Map((people ?? []).map((p) => [p.envelope_id, p.email]));
    const crowdEmails = new Set(crowd.map((c) => c.email));
    const crowdDocs = [...perEnvelope.values()].filter((e) => crowdEmails.has(e));
    check(`${CROWD} visitors at the same moment get ${CROWD} distinct documents, each for its own person, each opened for them (${seconds} s)`,
      landed.every(Boolean) && new Set(envIds).size === CROWD + 1 && new Set(crowdDocs).size === CROWD, `opened ${landed.filter(Boolean).length}, documents ${new Set(crowdDocs).size}`);
    await Promise.all(pages.map((p) => p.close()));

    // ---------- the next visitor: the daily limit ----------
    const late = await visitor(browser, link, { name: `Late ${tag}`, email: `e2e-late-${tag}@example.test` });
    await send(late);
    const lateText = await pageText(late);
    check('the next visitor is told the form has reached its limit for today', lateText.includes('reached its limit for today') && !late.url().endsWith('/sign'));
    await late.close();
    await owner.reload({ waitUntil: 'networkidle0' });
    check('the template page shows today\u2019s count against the limit', (await pageText(owner)).includes(`${CROWD + 1} today (limit ${CROWD + 1})`));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `FORMS E2E FAILED (${failed} of ${results.length})` : `FORMS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`FORMS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
