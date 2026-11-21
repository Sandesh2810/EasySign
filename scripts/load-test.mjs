// npm run load-test [-- --signers 100 --documents 30 --concurrency 10 --watch <url> --app <url>]
// Phase 5 slice 9 (AT5.3, D-97): simulates many signers at once and measures what matters on a small server.
//   * Its own synthetic workspace makes --documents documents (default 30) for --signers people (default 100), all
//     signing at the same time (parallel routing), each sent as a link (no email).
//   * Each signer is a separate private browser window that opens the link, agrees and signs, --concurrency at a time.
//   * Measured: each step's time (open, agree, sign), errors (failed signers, server errors), how long sealing takes
//     after the last signature, the email queue while it runs, and the response time of --watch (another site, such as
//     the other app on the server: it is only fetched, read-only) and of this app's sign-in page, before, during and
//     after the run.
//   * The report is written to exports\phase5\load-test-<time>.json and .md.
//   * Afterwards the emails this run queued (completion copies) are marked not sent, so they never use the daily email
//     allowance.
// Safety: it refuses any address other than this PC unless --approved-by "<name, date>" is given (the server is shared
// with another app; a run there needs Sandesh's go-ahead and a quiet time, RUNBOOK "Load test").
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import { deriveToken, hashToken, newNonce } from '../src/lib/signer-token.ts';
import { isLocalTarget, spread, stats } from '../src/lib/load-stats.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const int = (n, d, min, max) => {
  const v = Number.parseInt(argAt(n) ?? '', 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SIGNERS = int('--signers', 100, 1, 500);
const DOCUMENTS = int('--documents', 30, 1, 200);
const CONCURRENCY = int('--concurrency', 10, 1, 50);
const WATCH = argAt('--watch') ?? null;
const APPROVED = argAt('--approved-by') ?? null;
const OUT = path.resolve(appDir, '..', 'exports', 'phase5');
const OWNER = { email: 'load-owner@example.test', name: 'Lou Load' };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const tag = randomBytes(3).toString('hex');
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function timed(url) {
  const t = performance.now();
  try {
    const r = await fetch(url, { redirect: 'manual', cache: 'no-store' });
    await r.arrayBuffer();
    return { ms: performance.now() - t, ok: r.status < 500 };
  } catch {
    return { ms: performance.now() - t, ok: false };
  }
}

async function main() {
  const local = isLocalTarget(APP);
  if (!local && !APPROVED) throw new Error(`Refusing to load-test ${APP}: it is not this PC. A run on the server needs Sandesh's go-ahead; pass --approved-by "<name, date>" (RUNBOOK "Load test").`);
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  mkdirSync(OUT, { recursive: true });
  log(`Load test against ${APP}: ${SIGNERS} signers on ${DOCUMENTS} documents, ${CONCURRENCY} at a time${WATCH ? `, watching ${WATCH}` : ''}${APPROVED ? ` (approved by ${APPROVED})` : ''}`);

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 10000, daily_recipient_cap: 10000 }).eq('user_id', u.id);
  const org = (await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single()).data.org_id;

  // ---------- the documents ----------
  const tokenKey = process.env.SIGNER_TOKEN_KEY;
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Load test ${tag}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const links = [];
  const envelopeIds = [];
  const counts = spread(SIGNERS, DOCUMENTS);
  const setupStart = performance.now();
  for (const [d, n] of counts.entries()) {
    const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Load test ${tag} #${d + 1}`, p_folder_id: null });
    const storagePath = `${org}/${env.id}/doc1.pdf`;
    const up = await db.storage.from('originals').upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'load.pdf', p_storage_backend: 'supabase', p_storage_path: storagePath,
      p_sha256: sha, p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
    await rpc(db, 'set_routing_mode', { p_actor: u.id, p_envelope_id: env.id, p_mode: 'parallel' });
    const people = Array.from({ length: n }, (_, i) => ({ name: `Load Signer ${d + 1}.${i + 1}`, email: `load-${tag}-${d + 1}-${i + 1}@example.test`, role: 'signer', routing_order: 1 }));
    const saved = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: people });
    await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: saved.map((r, i) => ({ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.1 + i * 0.12, w: 0.35, h: 0.07 })) });
    const tokens = saved.map((r) => {
      const tokenId = randomUUID();
      const nonce = newNonce();
      const token = deriveToken(tokenKey, tokenId, nonce);
      links.push({ url: `${APP}/s#${token}`, envelope: env.id });
      return { recipient_id: r.id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') };
    });
    await rpc(db, 'send_envelope', { p_actor: u.id, p_envelope_id: env.id, p_tokens: tokens, p_expires_at: new Date(Date.now() + 2 * 86400_000).toISOString(), p_delivery: 'link' });
    envelopeIds.push(env.id);
  }
  log(`set up ${envelopeIds.length} documents and ${links.length} links in ${Math.round((performance.now() - setupStart) / 1000)} s`);

  // ---------- background measurements ----------
  const samples = { watch: [], app: [], queue: [] };
  let phase = 'before';
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [w, a, q] = await Promise.all([
        WATCH ? timed(WATCH) : Promise.resolve(null),
        timed(`${APP}/login`),
        db.from('notification_outbox').select('status, not_before').eq('org_id', org).in('status', ['queued', 'sending']),
      ]);
      const now = Date.now();
      const due = (q.data ?? []).filter((r) => !r.not_before || Date.parse(r.not_before) <= now).length;
      if (w) samples.watch.push({ phase, ...w });
      samples.app.push({ phase, ...a });
      samples.queue.push({ phase, at: now, due });
      await sleep(3000);
    }
  })();
  await sleep(10_000); // a baseline before any signer starts

  // ---------- the signers ----------
  phase = 'during';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 600_000, args: ['--no-first-run', '--disable-gpu'] });
  const steps = { open: [], agree: [], sign: [], total: [] };
  const failures = [];
  let serverErrors = 0;
  const runStart = performance.now();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= links.length) return;
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.on('response', (r) => {
        if (r.status() >= 500) serverErrors++;
      });
      await page.setBypassCSP(true);
      await page.setViewport({ width: 1100, height: 900 });
      // each signer comes from its own address (this PC only: on a server the proxy adds the real one)
      await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `10.${(i >> 8) & 255}.${i & 255}.${1 + (i % 250)}`, 'Accept-Language': 'en' });
      const t0 = performance.now();
      let step = 'open the link';
      // wait until the element is there and visible, then click it (a click during a re-render can miss)
      const press = async (selector, timeout = 60_000) => {
        const el = await page.waitForSelector(selector, { visible: true, timeout });
        await el.click();
      };
      try {
        await page.goto(links[i].url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForSelector('input[name="agree"]', { timeout: 90_000 });
        const t1 = performance.now();
        step = 'agree';
        await press('input[name="agree"]');
        await press('main form button[type="submit"]');
        await page.waitForSelector('button[data-field-kind="signature"]', { timeout: 90_000 });
        const t2 = performance.now();
        step = 'open the signature box';
        await press('button[data-field-kind="signature"]');
        await page.waitForSelector('[role="tablist"]', { visible: true, timeout: 30_000 });
        step = 'type the signature';
        await press('[role="tab"]::-p-text(Type)');
        await press('button::-p-text(Use this signature)');
        await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 60_000 });
        step = 'finish';
        await press('button::-p-text(Finish)');
        await page.waitForSelector('#finish-title', { visible: true, timeout: 30_000 });
        step = 'adopt and sign';
        await press('button::-p-text(Adopt and Sign)');
        await page.waitForFunction(() => /Thank you/.test(document.body.innerText), { timeout: 90_000 });
        const t3 = performance.now();
        steps.open.push(t1 - t0);
        steps.agree.push(t2 - t1);
        steps.sign.push(t3 - t2);
        steps.total.push(t3 - t0);
      } catch (e) {
        const seen = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 240)).catch(() => '(page unreadable)');
        if (failures.length < 5) await page.screenshot({ path: path.join(OUT, `load-fail-${i + 1}.png`) }).catch(() => undefined);
        failures.push({ signer: i + 1, step, error: e instanceof Error ? e.message.slice(0, 160) : String(e), seconds: Math.round((performance.now() - t0) / 1000), seen });
      } finally {
        await ctx.close().catch(() => undefined);
      }
      if ((i + 1) % 10 === 0) log(`${i + 1} of ${links.length} signers done (${failures.length} failed)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();
  const runSeconds = (performance.now() - runStart) / 1000;
  log(`all signers finished in ${Math.round(runSeconds)} s; waiting for sealing`);

  // ---------- sealing ----------
  phase = 'sealing';
  const sealDeadline = Date.now() + 15 * 60_000;
  let envs = [];
  while (Date.now() < sealDeadline) {
    envs = (await db.from('envelopes').select('id, status, sealed_at').in('id', envelopeIds)).data ?? [];
    if (envs.every((e) => e.status === 'completed' || e.status === 'failed_sealing')) break;
    await sleep(3000);
  }
  const { data: people } = await db.from('recipients').select('envelope_id, completed_at').in('envelope_id', envelopeIds);
  const lastSignature = new Map();
  for (const p of people ?? []) if (p.completed_at) lastSignature.set(p.envelope_id, Math.max(lastSignature.get(p.envelope_id) ?? 0, Date.parse(p.completed_at)));
  const sealWaits = envs.filter((e) => e.sealed_at && lastSignature.has(e.id)).map((e) => Date.parse(e.sealed_at) - lastSignature.get(e.id));
  const allSealedAt = Math.max(...envs.filter((e) => e.sealed_at).map((e) => Date.parse(e.sealed_at)));
  const lastSigned = Math.max(...[...lastSignature.values()]);
  phase = 'after';
  await sleep(10_000);
  sampling = false;
  await sampler;

  // ---------- documents a failed signer left open are cancelled, so they never expire into emails later ----------
  for (const e of envs.filter((x) => !['completed', 'failed_sealing'].includes(x.status))) {
    await db.rpc('void_envelope', { p_actor: u.id, p_envelope_id: e.id, p_reason: 'Load test ended' });
  }
  // ---------- emails this run queued: never sent ----------
  const { data: queued } = await db.from('notification_outbox').update({ status: 'dead', last_error: 'load test: not sent' }).eq('org_id', org).in('status', ['queued', 'deferred', 'failed']).select('id');

  // ---------- the report ----------
  const by = (list, ph) => stats(list.filter((s) => s.phase === ph).map((s) => s.ms));
  const errorsBy = (list, ph) => list.filter((s) => s.phase === ph && !s.ok).length;
  const report = {
    at: new Date().toISOString(),
    app: APP,
    approvedBy: APPROVED,
    plan: { signers: links.length, documents: envelopeIds.length, concurrency: CONCURRENCY },
    signers: { completed: steps.total.length, failed: failures.length, failures: failures.slice(0, 20), serverErrors, seconds: Math.round(runSeconds), perMinute: Math.round((steps.total.length / runSeconds) * 60) },
    steps: { openLink: stats(steps.open), agree: stats(steps.agree), sign: stats(steps.sign), total: stats(steps.total) },
    sealing: {
      completed: envs.filter((e) => e.status === 'completed').length,
      failed: envs.filter((e) => e.status === 'failed_sealing').length,
      notFinished: envs.filter((e) => !['completed', 'failed_sealing'].includes(e.status)).length,
      afterLastSignature: stats(sealWaits),
      allSealedSecondsAfterLastSignature: Number.isFinite(allSealedAt) && Number.isFinite(lastSigned) ? Math.round((allSealedAt - lastSigned) / 1000) : null,
    },
    emailQueue: { maxDue: Math.max(0, ...samples.queue.map((q) => q.due)), dueAtEnd: samples.queue.at(-1)?.due ?? null, markedNotSent: queued?.length ?? 0 },
    thisAppSignIn: { before: by(samples.app, 'before'), during: by(samples.app, 'during'), sealing: by(samples.app, 'sealing'), after: by(samples.app, 'after'), errorsDuring: errorsBy(samples.app, 'during') },
    watched: WATCH ? { url: WATCH, before: by(samples.watch, 'before'), during: by(samples.watch, 'during'), after: by(samples.watch, 'after'), errorsDuring: errorsBy(samples.watch, 'during') } : null,
  };
  const stamp = report.at.replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT, `load-test-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const ms = (s) => (s.n ? `p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms (${s.n})` : 'no data');
  const md = [
    `# Load test, ${report.at.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Target ${APP}${APPROVED ? ` (approved by ${APPROVED})` : ''}. ${report.plan.signers} signers on ${report.plan.documents} documents, ${CONCURRENCY} at a time.`,
    '',
    `- Signers finished: ${report.signers.completed} of ${report.plan.signers} in ${report.signers.seconds} s (${report.signers.perMinute} a minute); failed: ${report.signers.failed}; server errors seen: ${serverErrors}.`,
    `- Open the link: ${ms(report.steps.openLink)}`,
    `- Agree: ${ms(report.steps.agree)}`,
    `- Sign (create the signature, adopt and sign): ${ms(report.steps.sign)}`,
    `- Whole signing, per person: ${ms(report.steps.total)}`,
    `- Sealing: ${report.sealing.completed} sealed, ${report.sealing.failed} failed, ${report.sealing.notFinished} not finished; after the last signature: ${ms(report.sealing.afterLastSignature)}; all sealed ${report.sealing.allSealedSecondsAfterLastSignature} s after the last signature.`,
    `- Email queue (due now): at most ${report.emailQueue.maxDue}, at the end ${report.emailQueue.dueAtEnd}; ${report.emailQueue.markedNotSent} emails from this run marked not sent.`,
    `- This app's sign-in page: before ${ms(report.thisAppSignIn.before)}; during ${ms(report.thisAppSignIn.during)}; after ${ms(report.thisAppSignIn.after)}; errors during ${report.thisAppSignIn.errorsDuring}.`,
    ...(report.watched ? [`- Watched site ${WATCH}: before ${ms(report.watched.before)}; during ${ms(report.watched.during)}; after ${ms(report.watched.after)}; errors during ${report.watched.errorsDuring}.`] : ['- No other site watched (on the server, pass --watch with the other app\u2019s address).']),
    ...(failures.length ? ['', 'First failures:', ...failures.slice(0, 5).map((f) => `- signer ${f.signer}, step "${f.step}" after ${f.seconds} s: ${f.error}. The page showed: "${f.seen}"`)] : []),
    '',
  ].join('\n');
  writeFileSync(jsonPath.replace(/\.json$/, '.md'), md);
  console.log(`\n${md}`);
  const ok = report.signers.failed === 0 && serverErrors === 0 && report.sealing.completed === envelopeIds.length;
  console.log(ok ? `LOAD TEST COMPLETED: every signer signed and every document sealed. Report: ${jsonPath}` : `LOAD TEST FOUND PROBLEMS (see the report): ${jsonPath}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`LOAD TEST could not run: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
