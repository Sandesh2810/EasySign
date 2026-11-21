// npm run e2e:comments [-- --app http://localhost:3000]
// End-to-end check of comments and scheduled send (Phase 4 slice 8, D-84) through the real pages and the real worker:
// * a signer asks a question before agreeing; the sender is told, answers on the document page; the answer email goes
//   out through the worker (log mode in development); the signer sees the answer; both are in the audit trail;
// * the sender schedules a document for later: the draft is locked and shows when; cancelling unlocks it; scheduled
//   again, the worker sends it once its time has come.
// Needs the app AND the background worker running. Synthetic accounts only. Signs in once.
import { spawnSync } from 'node:child_process';
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
const QUESTION = `Is clause 4 negotiable? (${tag})`;
const ANSWER = `Yes, within 10% (${tag}).`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageText = (p) => p.evaluate(() => document.body.innerText);

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function draft(db, u, org, title, signer) {
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `${title} ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`${title} ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const srcPath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(srcPath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'doc.pdf', p_storage_backend: 'supabase', p_storage_path: srcPath,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ ...signer, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.75, w: 0.35, h: 0.07 }] });
  return { env, rid: r.id };
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Comments and scheduled send end-to-end check against ${APP}`);
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
    const s = await browser.newPage();
    await s.setBypassCSP(true);
    await s.setViewport({ width: 1280, height: 1000 });
    await s.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await s.type('#email', OWNER);
    await s.type('#password', password);
    await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), s.click('form button[type="submit"]')]);

    // ---------- comments ----------
    const q = await draft(db, u, org, 'Supply agreement', { name: 'Ann Able', email: `e2e-ann8-${tag}@example.test` });
    await s.goto(`${APP}/app/envelopes/${q.env.id}`, { waitUntil: 'networkidle0' });
    await s.click('button[name="delivery"][value="email"]');
    for (let i = 0; i < 30; i++) {
      if ((await db.from('envelopes').select('status').eq('id', q.env.id).single()).data.status === 'sent') break;
      await sleep(500);
    }
    const links = await rpc(db, 'reveal_signing_links', { p_actor: u.id, p_envelope_id: q.env.id });
    const token = deriveToken(process.env.SIGNER_TOKEN_KEY, links[0].token_id, Buffer.from(links[0].nonce_hex, 'hex'));
    const ann = await (await browser.createBrowserContext()).newPage();
    await ann.setBypassCSP(true);
    await ann.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
    await ann.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await ann.click('summary::-p-text(Questions for)');
    await ann.type('#question-text', QUESTION);
    await ann.click('button::-p-text(Send question)');
    await ann.waitForFunction((t) => document.body.innerText.includes(t) && !document.querySelector('#question-text').value, { timeout: 20000 }, QUESTION).catch(() => null);
    const asked = await pageText(ann);
    const { data: note } = await db.from('notifications').select('id').eq('user_id', u.id).eq('kind', 'comment_added').contains('payload', { envelope_id: q.env.id });
    check('a signer asks a question before agreeing; it shows in their conversation and the sender is told', asked.includes(QUESTION) && /You, \d{4}-\d{2}-\d{2}/.test(asked) && (note ?? []).length === 1);

    await s.goto(`${APP}/app/envelopes/${q.env.id}`, { waitUntil: 'networkidle0' });
    check('the sender sees the question under "Questions and answers"', (await pageText(s)).includes('Questions and answers') && (await pageText(s)).includes(QUESTION));
    await s.type(`#answer-${q.rid}`, ANSWER);
    await s.click('button::-p-text(Send answer)');
    await s.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 20000 }, ANSWER).catch(() => null);
    let mail = null;
    for (let i = 0; i < 40 && !(mail && ['sent', 'deferred'].includes(mail.status)); i++) {
      mail = (await db.from('notification_outbox').select('id, status, priority, last_error').eq('recipient_id', q.rid).eq('kind', 'comment_reply').maybeSingle()).data;
      if (!mail || !['sent', 'deferred'].includes(mail.status)) await sleep(1500);
    }
    // When the day's shared email allowance is used up (e.g. by many test runs), the budget manager rightly holds the
    // email until the daily reset (AT1.11). Then the worker's own code builds it without sending, to prove its content.
    let content = '';
    if (mail?.status === 'deferred' && /limit reached for today/.test(mail.last_error ?? '')) {
      const r = spawnSync(process.execPath, ['scripts/outbox-preview.mjs', mail.id, '--json'], { encoding: 'utf8' });
      const p = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}');
      content = p.subject?.includes('answered your question') && p.text?.includes(ANSWER) && p.to === `e2e-ann8-${tag}@example.test` ? 'ok' : `bad preview: ${r.stderr || r.stdout}`;
    }
    check('the sender answers; the answer email (P1) goes out through the worker, or is held by today\'s email limit with its content verified',
      (await pageText(s)).includes(ANSWER) && mail?.priority === 'P1' && (mail.status === 'sent' || content === 'ok'),
      `email status=${mail?.status ?? 'none'}${mail?.status === 'deferred' ? ` (held until the daily reset; worker-built content ${content})` : ''}`);
    await ann.reload({ waitUntil: 'networkidle0' });
    check('the signer sees the answer in their conversation', (await pageText(ann)).includes(ANSWER));
    const { data: evs } = await db.from('audit_events').select('payload').eq('envelope_id', q.env.id).eq('event_type', 'comment_added').order('seq');
    check('both messages are in the audit trail with their text', (evs ?? []).length === 2 && evs[0].payload.body === QUESTION && evs[1].payload.body === ANSWER);

    // ---------- scheduled send ----------
    const later = await draft(db, u, org, 'Monthly report', { name: 'Sol Solo', email: `e2e-sol8-${tag}@example.test` });
    const scheduleFor = async (minutes) => {
      await s.goto(`${APP}/app/envelopes/${later.env.id}`, { waitUntil: 'networkidle0' });
      await s.click('input[name="when"][value="later"]');
      await s.waitForSelector('#send-at');
      const local = await s.evaluate((mins) => {
        const d = new Date(Date.now() + mins * 60000);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      }, minutes);
      await s.evaluate((v) => {
        const el = document.querySelector('#send-at');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, local);
      await s.click('button::-p-text(Schedule, and share the links myself)');
      await s.waitForFunction(() => document.body.innerText.includes('Scheduled to be sent on'), { timeout: 20000 }).catch(() => null);
    };
    await scheduleFor(10);
    const { data: row } = await db.from('scheduled_sends').select('status, send_at').eq('envelope_id', later.env.id).single();
    const t = await pageText(s);
    check('the sender schedules it for later: the page shows when, the draft is locked, nothing is sent yet',
      t.includes('Scheduled to be sent on') && !t.includes('Add a person') && row?.status === 'scheduled'
        && Math.abs(new Date(row.send_at).getTime() - (Date.now() + 10 * 60000)) < 2 * 60000
        && (await db.from('envelopes').select('status').eq('id', later.env.id).single()).data.status === 'draft');
    await s.click('button::-p-text(Cancel the scheduled send)');
    await s.waitForFunction(() => !document.body.innerText.includes('Scheduled to be sent on') && document.body.innerText.includes('When to send'), { timeout: 20000 }).catch(() => null);
    const after = await pageText(s);
    const cancelled = (await db.from('scheduled_sends').select('status').eq('envelope_id', later.env.id).single()).data.status;
    check('cancelling unlocks the draft', after.includes('When to send') && after.includes('Add a person') && cancelled === 'cancelled',
      `when=${after.includes('When to send')} add=${after.includes('Add a person')} status=${cancelled}`);

    await scheduleFor(10);
    // bring the time forward instead of waiting ten minutes; the worker checks about once a minute
    await db.from('scheduled_sends').update({ send_at: new Date(Date.now() - 60000).toISOString() }).eq('envelope_id', later.env.id);
    let status = null;
    for (let i = 0; i < 60 && status !== 'sent'; i++) {
      status = (await db.from('envelopes').select('status').eq('id', later.env.id).single()).data.status;
      if (status !== 'sent') await sleep(2000);
    }
    const done = (await db.from('scheduled_sends').select('status').eq('envelope_id', later.env.id).single()).data;
    check('the worker sends it once its time has come', status === 'sent' && done.status === 'sent', `status=${status}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `COMMENTS E2E FAILED (${failed} of ${results.length})` : `COMMENTS E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`COMMENTS E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
