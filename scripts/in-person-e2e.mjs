// npm run e2e:inperson [-- --app http://localhost:3000]
// End-to-end check of in-person signing (Phase 4 slice 10, AT4.7, D-86) on a tablet-sized touch screen (768 x 1024),
// through the real pages and the real worker:
// * the sender adds a person who "Signs in person" in the people editor; sent by email, that person gets no email and
//   the sender is told it is their turn; the link made at sending does not work for them;
// * the host starts in-person signing with a PIN; the device shows the signing screen for that person; the host's own
//   account pages ask for the PIN meanwhile;
// * after 3 minutes without a touch the screen warns, then locks (also on reload); a wrong PIN is refused, the right
//   one unlocks; the person signs; the host takes the device back with the PIN and lands on the document;
// * the document page and the sealed certificate say "in person, hosted by …"; the audit trail has every step;
// * signing out from the PIN page ends an open in-person signing.
// Needs the app AND the background worker running. Synthetic accounts only. Signs in twice. Takes about 6 minutes.
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
const HOST = { email: 'inperson-host@example.test', name: 'Ida Inperson' };
const KIM = { name: 'Kim Keys', email: `e2e-kim-${randomBytes(3).toString('hex')}@example.test` };
const PIN = '4071';
const TABLET = { width: 768, height: 1024, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageText = (p) => p.evaluate(() => document.body.innerText);
/** A finger tap on an element, after bringing it to the middle of the screen (the page has a sticky header). */
async function tap(page, selector) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await el.tap();
}

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

/** A draft with one page; people and fields are added later. */
async function draft(db, userId, org, title) {
  const env = await rpc(db, 'create_envelope', { p_actor: userId, p_org_id: org, p_title: title, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`${title} ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const storagePath = `${org}/${env.id}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc(db, 'add_envelope_document', { p_actor: userId, p_envelope_id: env.id, p_filename: 'agreement.pdf', p_storage_backend: 'supabase', p_storage_path: storagePath,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  return { id: env.id, docId: doc.id };
}

/** Fields and sending for a draft whose only person signs in person; returns the link token made at sending. */
async function fieldsAndSend(db, userId, envId, docId, delivery) {
  const { data: people } = await db.from('recipients').select('id, role').eq('envelope_id', envId);
  const kim = people.find((r) => r.role === 'in_person');
  await rpc(db, 'save_fields', { p_actor: userId, p_envelope_id: envId, p_fields: [{ document_id: docId, recipient_id: kim.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const tokenId = randomUUID();
  const nonce = newNonce();
  const token = deriveToken(process.env.SIGNER_TOKEN_KEY, tokenId, nonce);
  await rpc(db, 'send_envelope', { p_actor: userId, p_envelope_id: envId,
    p_tokens: [{ recipient_id: kim.id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
    p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: delivery });
  return { kimId: kim.id, token };
}

async function startHosting(page, envId) {
  await page.goto(`${APP}/app/envelopes/${envId}`, { waitUntil: 'networkidle0' });
  await page.click('button::-p-text(Start signing in person)');
  await page.waitForSelector('dialog[open] input[type="password"]', { visible: true });
  const pins = await page.$$('dialog[open] input[type="password"]');
  await pins[0].type(PIN);
  await pins[1].type(PIN);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click(`button::-p-text(Hand the device to ${KIM.name})`)]);
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`In-person signing end-to-end check against ${APP} (tablet, 768 x 1024, touch)`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === HOST.email);
  if (!u) u = (await db.auth.admin.createUser({ email: HOST.email, password, email_confirm: true, user_metadata: { full_name: HOST.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  await db.from('profiles').update({ display_name: HOST.name }).eq('id', u.id);
  await rpc(db, 'in_person_end_for_host', { p_actor: u.id }); // nothing left over from an earlier run
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;
  const env = await draft(db, u.id, org, 'Tenancy agreement (in person)');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const host = await browser.newPage();
    const hostErrors = [];
    host.on('pageerror', (e) => hostErrors.push(String(e?.message ?? e)));
    host.on('console', (m) => {
      if (m.type() === 'error') hostErrors.push(m.text());
    });
    await host.setBypassCSP(true);
    await host.setViewport(TABLET);
    await host.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await host.type('#email', HOST.email);
    await host.type('#password', password);
    await Promise.all([host.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), host.click('form button[type="submit"]')]);

    // ---------- the people editor offers "Signs in person" ----------
    await host.goto(`${APP}/app/envelopes/${env.id}`, { waitUntil: 'networkidle0' });
    await host.type('input[id^="name-"]', KIM.name);
    await host.type('input[id^="email-"]', KIM.email);
    await host.select('select[id^="role-"]', 'in_person');
    await host.click('button::-p-text(Save people)');
    await host.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Saved'), { timeout: 20000 });
    const { data: saved } = await db.from('recipients').select('role, auth_method').eq('envelope_id', env.id);
    check('the people editor saves a person who signs in person', saved?.length === 1 && saved[0].role === 'in_person' && saved[0].auth_method === 'link');

    const { kimId, token } = await fieldsAndSend(db, u.id, env.id, env.docId, 'email');
    const { count: mails } = await db.from('notification_outbox').select('id', { count: 'exact', head: true }).eq('recipient_id', kimId);
    const { data: turn } = await db.from('notifications').select('payload').eq('user_id', u.id).eq('kind', 'in_person_turn').contains('payload', { envelope_id: env.id });
    check('sent by email, the in-person signer gets no email and the sender is told it is their turn', mails === 0 && (turn ?? []).length === 1);

    // ---------- the link made at sending does not work for them ----------
    const stranger = await (await browser.createBrowserContext()).newPage();
    await stranger.setBypassCSP(true);
    await stranger.setViewport(TABLET);
    await stranger.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
    await stranger.waitForSelector('input[name="agree"]', { timeout: 30000 }).catch(() => null);
    if (await stranger.$('input[name="agree"]')) {
      await tap(stranger, 'input[name="agree"]');
      await tap(stranger, 'button::-p-text(Agree and continue)');
      await stranger.waitForFunction(() => /in person on the host/i.test(document.body.innerText), { timeout: 15000 }).catch(() => null);
    }
    check('the link made at sending cannot be used to sign', /in person on the host/i.test(await pageText(stranger)));
    await stranger.close();

    // ---------- the host starts it; the device becomes the signing screen ----------
    await startHosting(host, env.id);
    // the page streams in; wait for the consent step and give it a moment to become interactive
    await host.waitForSelector('input[name="agree"]', { timeout: 30000 }).catch(() => null);
    await host.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => null);
    const signing = await pageText(host);
    check('the host starts in-person signing with a PIN; the tablet shows the signing screen for that person', host.url().endsWith('/sign') && signing.includes(`Signing in person with ${HOST.name}`) && signing.includes(`This screen is for ${KIM.name}`),
      `${host.url().replace(APP, '')} :: ${signing.replace(/\s+/g, ' ').slice(0, 300)}`);
    const other = await host.browserContext().newPage();
    await other.setBypassCSP(true);
    await other.goto(`${APP}/app/templates`, { waitUntil: 'networkidle0' });
    check('meanwhile the host\u2019s account pages ask for the PIN', other.url().includes('/in-person') && (await pageText(other)).includes('In-person signing in progress'));
    await other.close();
    await host.bringToFront();
    await sleep(500);

    // ---------- consent by touch, then the inactivity lock ----------
    await tap(host, 'input[name="agree"]');
    await tap(host, 'button::-p-text(Agree and continue)');
    await host.waitForSelector('button[aria-label^="Sign here"]', { timeout: 30000 }).catch(async () => {
      const state = await host.evaluate(() => {
        const box = document.querySelector('input[name="agree"]');
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Agree and continue'));
        return { checked: box?.checked ?? null, disabled: btn?.disabled ?? null, alerts: [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' | ') };
      });
      throw new Error(`no signing screen after agreeing: ${JSON.stringify(state)}; browser errors: ${hostErrors.join(' | ').slice(0, 600)}`);
    });
    const quietFrom = Date.now();
    await host.waitForSelector('[role="alertdialog"]', { visible: true, timeout: 200_000 });
    const warnedAfter = Math.round((Date.now() - quietFrom) / 1000);
    await host.waitForFunction(() => document.body.innerText.includes('The screen is locked'), { timeout: 60_000 });
    const lockedAfter = Math.round((Date.now() - quietFrom) / 1000);
    await host.reload({ waitUntil: 'networkidle0' });
    const { data: ses1 } = await db.from('in_person_sessions').select('id, locked_at').eq('recipient_id', kimId).is('ended_at', null).single();
    check('after a quiet spell the screen warns, then locks (and stays locked on reload)', warnedAfter >= 140 && lockedAfter >= 175 && (await pageText(host)).includes('The screen is locked') && Boolean(ses1?.locked_at), `warned ${warnedAfter} s, locked ${lockedAfter} s`);

    // ---------- the host's PIN unlocks; a wrong one does not ----------
    await host.type('#host-pin', '9081');
    await host.click('button::-p-text(Unlock)');
    await host.waitForFunction(() => document.body.innerText.includes('That PIN is not right'), { timeout: 15000 });
    await host.type('#host-pin', PIN);
    await host.click('button::-p-text(Unlock)');
    await host.waitForSelector('button[aria-label^="Sign here"]', { timeout: 30000 });
    check('a wrong PIN is refused; the host\u2019s PIN unlocks and signing carries on', true);

    // ---------- the person signs (touch), then the host takes the device back ----------
    await tap(host, 'button[aria-label^="Sign here"]');
    await host.waitForSelector('[role="tablist"]', { visible: true });
    await tap(host, '[role="tab"]::-p-text(Type)');
    await tap(host, 'button::-p-text(Use this signature)');
    await host.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await tap(host, 'button::-p-text(Finish)');
    await host.waitForSelector('#finish-title', { visible: true });
    await tap(host, 'button::-p-text(Adopt and Sign)');
    await host.waitForFunction((h) => document.body.innerText.includes(`Please hand the device back to ${h}`), { timeout: 30000 }, HOST.name);
    check('when the person has signed, the screen asks them to hand the device back', true);
    await host.type('#host-pin', PIN);
    await Promise.all([host.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), host.click('button::-p-text(Take the device back)')]);
    const { data: ses2 } = await db.from('in_person_sessions').select('end_reason').eq('id', ses1.id).single();
    check('with the PIN the host is back on the document, and the signing is recorded as finished', host.url().endsWith(`/app/envelopes/${env.id}`) && ses2?.end_reason === 'finished');

    // ---------- the record ----------
    let sealed = null;
    for (let i = 0; i < 60 && !sealed; i++) {
      const { data } = await db.from('envelopes').select('status, sealed_storage_path').eq('id', env.id).single();
      if (data.status === 'completed' && data.sealed_storage_path) sealed = data.sealed_storage_path;
      else await sleep(2000);
    }
    await host.reload({ waitUntil: 'networkidle0' });
    check('the document page says who hosted the signing', (await pageText(host)).includes(`In person, hosted by ${HOST.name}`));
    const { data: events } = await db.from('audit_events').select('event_type').eq('envelope_id', env.id);
    const kinds = new Set((events ?? []).map((e) => e.event_type));
    const wantEvents = ['in_person_started', 'in_person_locked', 'in_person_wrong_pin', 'in_person_unlocked', 'in_person_ended', 'recipient_signed'];
    check('the audit trail records the start, the lock, the wrong PIN, the unlock, the signature and the end', wantEvents.every((k) => kinds.has(k)), wantEvents.filter((k) => !kinds.has(k)).join(', '));
    if (sealed) {
      const file = Buffer.from(await (await db.storage.from('sealed').download(sealed)).data.arrayBuffer());
      const text = await pdfText(file);
      check('the sealed certificate says the person signed in person and who hosted it', text.includes('In-person signer') && text.includes(`hosted by ${HOST.name} <${HOST.email}>`));
    } else check('the background worker sealed the document', false, 'is the worker running?');

    // ---------- signing out ends an open in-person signing ----------
    const env2 = await draft(db, u.id, org, 'Second agreement (in person)');
    await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env2.id, p_recipients: [{ name: KIM.name, email: KIM.email, role: 'in_person', routing_order: 1 }] });
    await fieldsAndSend(db, u.id, env2.id, env2.docId, 'link');
    await startHosting(host, env2.id);
    await host.goto(`${APP}/app`, { waitUntil: 'networkidle0' });
    await Promise.all([host.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), host.click('button::-p-text(Sign out)')]);
    const { data: ses3 } = await db.from('in_person_sessions').select('end_reason').eq('envelope_id', env2.id).single();
    check('signing out from the PIN page ends the in-person signing', host.url().includes('/login') && ses3?.end_reason === 'signed_out');
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `IN-PERSON E2E FAILED (${failed} of ${results.length})` : `IN-PERSON E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`IN-PERSON E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
