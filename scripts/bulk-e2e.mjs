// npm run e2e:bulk [-- --app http://localhost:3000]
// End-to-end check of bulk send (Phase 4 slice 9, AT4.2, D-85) through the real pages and the real worker:
// * a 200-row CSV with 5 bad rows is uploaded on the template's bulk page: the page shows 195 ready and the 5 reasons;
//   sent with "I share the links myself", the worker creates and sends exactly 195 documents (one per row, each with its
//   row's value prefilled); the 5 are reported with their reasons on the batch page and in the CSV report;
// * no duplicates on retry: a row whose document was already sent but not recorded is picked up again and counted, and
//   no second document is made;
// * a batch sent by email is paced by the email budget: only what today's allowance can carry goes out, the rest waits
//   for the next day; cancelling it stops every row not yet sent.
// Needs the app AND the background worker running. Synthetic accounts only. Signs in once. Takes a few minutes.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const tag = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageText = (p) => p.evaluate(() => document.body.innerText);

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

/** A one-person template ("Tenant") with a signature and a named number field "rent", made the way "Save as template" makes it. */
async function makeTemplate(db, u, org) {
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Lease source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Lease ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'lease.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Tenant', email: `e2e-tenant-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [
    { document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.35, h: 0.07 },
    { document_id: doc.id, recipient_id: r.id, type: 'number', page: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.035, options: { name: 'rent', decimals: 0, min: 1 } },
  ] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  const copied = await db.storage.from('originals').copy(srcPath, tplPath);
  if (copied.error) throw new Error(`template copy: ${copied.error.message}`);
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `Lease ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Tenant' }], p_storage_path: tplPath });
  return templateId;
}

async function uploadCsv(s, templateId, csv, dir, name) {
  const file = path.join(dir, name);
  writeFileSync(file, csv);
  await s.goto(`${APP}/app/templates/${templateId}/bulk`, { waitUntil: 'networkidle0' });
  const input = await s.$('#bulk-file');
  await input.uploadFile(file);
  await s.waitForFunction(() => /ready, \d+ with a problem/.test(document.body.innerText), { timeout: 20000 });
}

async function waitFor(fn, ms, every = 3000) {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(every);
    v = await fn();
  }
  return v;
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Bulk send end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER, password, email_confirm: true, user_metadata: { full_name: 'Tess Teamowner' } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;
  const templateId = await makeTemplate(db, u, org);
  const dir = mkdtempSync(path.join(tmpdir(), 'ynms-bulk-'));

  // 200 rows: 195 good, 5 bad (empty name, bad email, duplicate, bad value, rent below the minimum)
  const lines = ['name,email,rent'];
  for (let i = 1; i <= 200; i++) lines.push(`Person ${i},e2e-p${i}-${tag}@example.test,${1000 + i}`);
  // lines[n] is row n (lines[0] is the header)
  lines[10] = `,e2e-p10-${tag}@example.test,1010`;
  lines[50] = `Person 50,not-an-email,1050`;
  lines[90] = `Person 90,e2e-p1-${tag}@example.test,1090`;
  lines[130] = `Person 130,e2e-p130-${tag}@example.test,lots`;
  lines[170] = `Person 170,e2e-p170-${tag}@example.test,0`;
  // a cell that looks like a spreadsheet formula, in a good row (the report must neutralise it)
  lines[6] = `"=HYPERLINK(""http://evil"")",e2e-p6-${tag}@example.test,1006`;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.setViewport({ width: 1280, height: 1000 });
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);

    // ---------- 200 rows, 5 bad, links shared by the sender ----------
    await uploadCsv(s, templateId, lines.join('\n'), dir, 'people.csv');
    const preview = await pageText(s);
    check('the preview shows 195 ready and the 5 reasons, before anything is created',
      preview.includes('195 ready, 5 with a problem') && preview.includes('Row 10: The name is empty.') && preview.includes('Row 50') && preview.includes('not a valid email address')
        && preview.includes('Row 90') && preview.includes('already on row 1') && preview.includes('Row 130') && preview.includes('Row 170'));
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }), s.click('button::-p-text(Create 195 documents)')]);
    const batchId = s.url().split('/app/bulk/')[1]?.split(/[?#]/)[0];
    check('creating the batch opens its page', /^[0-9a-f-]{36}$/.test(batchId ?? ''));

    const view = () => rpc(db, 'bulk_batch_view', { p_actor: u.id, p_batch_id: batchId });
    const t0 = Date.now();
    const done = await waitFor(async () => (await view()).status === 'done', 15 * 60_000, 5000);
    const v = await view();
    check(`the worker creates and sends exactly 195 documents (${Math.round((Date.now() - t0) / 1000)} s)`, Boolean(done) && v.counts?.sent === 195 && v.counts?.invalid === 5, JSON.stringify(v.counts));
    const ids = v.items.filter((i) => i.status === 'sent').map((i) => i.envelope_id);
    const { data: envs } = await db.from('envelopes').select('id, status, title').in('id', ids);
    const { count: perRow } = await db.from('recipients').select('id', { count: 'exact', head: true }).in('envelope_id', ids);
    const { data: rentVals } = await db.from('field_values').select('value_text, fields!inner(options)').in('envelope_id', ids.slice(0, 5));
    check('one sent document per good row, each for that row\u2019s person with their rent prefilled',
      new Set(ids).size === 195 && envs?.length === 195 && envs.every((e) => e.status === 'sent') && perRow === 195 && (rentVals ?? []).length === 5 && rentVals.every((r) => /^1\d{3}$/.test(r.value_text)));
    const reasons = v.items.filter((i) => i.status === 'invalid').map((i) => `${i.row_no}:${i.reason}`);
    check('the 5 bad rows are kept with their reasons', reasons.length === 5 && reasons[0].startsWith('10:The name is empty.') && reasons.some((r) => r.startsWith('170:rent:')), reasons.join(' | '));
    // load the batch page fresh first (the tab sat idle while the worker ran; the dev server may have reloaded it)
    await s.goto(`${APP}/app/bulk/${batchId}`, { waitUntil: 'networkidle0' });
    const page = await pageText(s);
    const report = await s.evaluate(async (id) => (await fetch(`/api/bulk/${id}/report`)).text(), batchId);
    check('the CSV report lists every row with its status and reason, and neutralises spreadsheet formulas',
      report.split('\r\n').length >= 201 && report.includes('not sent (problem in the file)') && report.includes(`"'=HYPERLINK(""http://evil"")"`) && !/(^|,)=HYPERLINK/m.test(report));
    check('the batch page shows the totals and every row', page.includes('Problem in the file') && page.includes('Row') && page.includes('Person 200') && page.includes('The name is empty.'));

    // ---------- no duplicates on retry ----------
    const victim = v.items.find((i) => i.status === 'sent' && i.row_no === 7);
    const before = (await db.from('envelopes').select('id', { count: 'exact', head: true }).like('title', `Lease ${tag} \u2014 %`)).count;
    // as if the worker had sent row 7 and stopped before recording it: the row is waiting again, with its (sent) document
    await db.from('bulk_batches').update({ status: 'active', finished_at: null }).eq('id', batchId);
    await db.from('bulk_items').update({ status: 'pending', locked_until: null, not_before: new Date(Date.now() - 60000).toISOString() }).eq('batch_id', batchId).eq('row_no', 7);
    const recovered = await waitFor(async () => (await view()).items.find((i) => i.row_no === 7)?.status === 'sent', 120_000);
    const after = (await db.from('envelopes').select('id', { count: 'exact', head: true }).like('title', `Lease ${tag} \u2014 %`)).count;
    const row7 = (await view()).items.find((i) => i.row_no === 7);
    check('a retried row whose document was already sent is counted, and no second document is made', Boolean(recovered) && after === before && row7.envelope_id === victim.envelope_id, `before=${before} after=${after}`);

    // ---------- by email: paced by the email budget, then cancelled ----------
    const emailLines = ['name,email'];
    for (let i = 1; i <= 12; i++) emailLines.push(`Mail ${i},e2e-m${i}-${tag}@example.test`);
    await uploadCsv(s, templateId, emailLines.join('\n'), dir, 'email.csv');
    await s.click('input[name="bulk-delivery"]:not(:checked)');
    const estimate = await pageText(s);
    check('choosing email shows how many can go today and about how many days it takes', /this takes about \d+ day/.test(estimate) && /\(\d+ can go today\)/.test(estimate), estimate.match(/takes about[^.]*\./)?.[0] ?? '');
    const canToday = Number(estimate.match(/\((\d+) can go today\)/)?.[1] ?? '-1');
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }), s.click('button::-p-text(Create 12 documents)')]);
    const mailBatch = s.url().split('/app/bulk/')[1]?.split(/[?#]/)[0];
    const mview = () => rpc(db, 'bulk_batch_view', { p_actor: u.id, p_batch_id: mailBatch });
    // wait until every row has been looked at once: sent, or waiting for a later day
    const settled = await waitFor(async () => {
      const x = await mview();
      return x.items.every((i) => i.status === 'sent' || (i.status === 'pending' && new Date(i.not_before) > new Date(Date.now() + 60_000))) ? x : null;
    }, 5 * 60_000);
    const sentByMail = settled ? settled.items.filter((i) => i.status === 'sent').length : -1;
    const waiting = settled ? settled.items.filter((i) => i.status === 'pending') : [];
    const nextMidnight = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).getTime();
    check('by email, only what today\u2019s allowance can carry goes out; the rest waits for the next day',
      Boolean(settled) && sentByMail <= Math.max(0, canToday) && sentByMail + waiting.length === 12
        && waiting.every((i) => new Date(i.not_before).getTime() === nextMidnight && /next day/.test(i.reason ?? '')),
      `today=${canToday} sent=${sentByMail} waiting=${waiting.length}`);
    await s.goto(`${APP}/app/bulk/${mailBatch}`, { waitUntil: 'networkidle0' });
    await s.click('button::-p-text(Cancel the rest)');
    await s.click('button::-p-text(Yes, cancel the rest)');
    await s.waitForFunction(() => document.body.innerText.includes('cancelled'), { timeout: 20000 }).catch(() => null);
    const cancelled = await mview();
    check('cancelling stops every row not yet sent; sent documents stay',
      cancelled.status === 'cancelled' && (cancelled.counts?.cancelled ?? 0) === waiting.length && (cancelled.counts?.sent ?? 0) === sentByMail && !cancelled.items.some((i) => i.status === 'pending'));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `BULK E2E FAILED (${failed} of ${results.length})` : `BULK E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`BULK E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
