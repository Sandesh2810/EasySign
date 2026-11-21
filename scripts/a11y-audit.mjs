// npm run a11y [-- --app http://localhost:3100]
// Accessibility audit of the signer and sender critical paths (Phase 3 slice 9, AT3.9; carried AT1.13).
// Drives the RUNNING app in headless Chrome (the Chrome already installed on this PC; nothing is downloaded):
//   * axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on every page and every open dialog of the paths;
//   * Lighthouse accessibility score on the signer pages (target 95 or more) and the sign-in pages;
//   * a keyboard walk (Tab through each signer page; every stop must show a visible focus indicator).
// Test data: a fixed synthetic sender a11y-sender@example.test whose password is made up fresh for each run, kept
// in memory only and never printed; each run leaves one signed and one draft test document (sent documents cannot
// be deleted, by design). Nothing is emailed (links are "shared by the sender").
// Results: printed, and written to EasySign\exports\phase3\a11y\. Exit code 1 if any check fails.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import lighthouse from 'lighthouse';
import { deriveToken, hashToken, newNonce } from '../src/lib/signer-token.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SENDER_EMAIL = 'a11y-sender@example.test';
const SIGNER = { name: 'Ada Access', email: 'a11y-signer@example.test' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const LH_MIN = 95;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const results = [];
let pageRef = null;
const failures = [];
const say = (m) => console.log(m);

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function makePdf(title) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(title, { x: 72, y: 700, size: 20, font });
  page.drawText('A short synthetic agreement used to check accessibility. It contains no real data.', { x: 72, y: 660, size: 11, font });
  page.drawText(`Run ${randomUUID()}`, { x: 72, y: 640, size: 9, font });
  return pdf.save();
}

/** One synthetic sender (fresh random password each run, never printed), one draft and one sent document. */
async function prepare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const tokenKey = process.env.SIGNER_TOKEN_KEY;
  if (!url || !secret || !tokenKey) throw new Error('Settings are missing. Run "npm run setup:env" first.');
  const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  let sender = list.data?.users.find((u) => u.email === SENDER_EMAIL);
  if (!sender) {
    const created = await db.auth.admin.createUser({ email: SENDER_EMAIL, password, email_confirm: true, user_metadata: { full_name: 'Accessibility Sender' } });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    sender = created.data.user;
  } else {
    const upd = await db.auth.admin.updateUserById(sender.id, { password });
    if (upd.error) throw new Error(`updateUser: ${upd.error.message}`);
  }
  // 'trusted' keeps this synthetic sender's completion emails out of the small daily pool new accounts share, which the
  // route tests' sender needs (each run here completes documents; 18 emails a day otherwise).
  const controls = await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100000, daily_recipient_cap: 100000 }).eq('user_id', sender.id);
  if (controls.error) throw new Error(`account_controls: ${controls.error.message}`);
  const membership = await db.from('memberships').select('org_id').eq('user_id', sender.id).eq('role', 'owner').single();
  if (membership.error) throw new Error(`membership: ${membership.error.message}`);
  const orgId = membership.data.org_id;

  const makeEnvelope = async (title, people, withText = false, withNewTypes = false) => {
    const env = await rpc(db, 'create_envelope', { p_actor: sender.id, p_org_id: orgId, p_title: title, p_folder_id: null });
    const bytes = await makePdf(title);
    const storagePath = `${orgId}/${env.id}/doc1.pdf`;
    const up = await db.storage.from('originals').upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    const doc = await rpc(db, 'add_envelope_document', {
      p_actor: sender.id, p_envelope_id: env.id, p_filename: 'agreement.pdf', p_storage_backend: 'supabase', p_storage_path: storagePath,
      p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf',
    });
    const saved = await rpc(db, 'save_recipients', { p_actor: sender.id, p_envelope_id: env.id, p_recipients: people.map((p, i) => ({ ...p, role: 'signer', routing_order: i + 1 })) });
    const fields = saved.flatMap((r, i) => [
      { document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.12, y: 0.55 + i * 0.15, w: 0.35, h: 0.07 },
      { document_id: doc.id, recipient_id: r.id, type: 'date_signed', page: 1, x: 0.55, y: 0.57 + i * 0.15, w: 0.25, h: 0.04 },
      ...(withText ? [{ document_id: doc.id, recipient_id: r.id, type: 'text', page: 1, x: 0.12, y: 0.45 + i * 0.15, w: 0.4, h: 0.04, required: true }] : []),
      // Phase 4 slice 3 (D-78): every new type, optional so the signing flow below is unchanged
      ...(withNewTypes ? [
        { document_id: doc.id, recipient_id: r.id, type: 'checkbox', page: 1, x: 0.12, y: 0.12, w: 0.03, h: 0.022, required: false },
        { document_id: doc.id, recipient_id: r.id, type: 'radio', page: 1, x: 0.2, y: 0.12, w: 0.3, h: 0.08, required: false, options: { choices: ['Monthly', 'Yearly'] } },
        { document_id: doc.id, recipient_id: r.id, type: 'dropdown', page: 1, x: 0.55, y: 0.12, w: 0.3, h: 0.035, required: false, options: { choices: ['Red', 'Green'] } },
        { document_id: doc.id, recipient_id: r.id, type: 'number', page: 1, x: 0.12, y: 0.24, w: 0.2, h: 0.035, required: false, options: { min: 0, max: 100, name: `qty_${i}` } },
        // Phase 4 slice 4 (D-79): a calculated field (shown) and a field with a condition (hidden until qty > 50)
        { document_id: doc.id, recipient_id: r.id, type: 'formula', page: 1, x: 0.12, y: 0.38, w: 0.2, h: 0.035, required: false, options: { formula: `qty_${i} * 2.5` } },
        { document_id: doc.id, recipient_id: r.id, type: 'text', page: 1, x: 0.4, y: 0.38, w: 0.3, h: 0.035, required: false, options: { show_if: `qty_${i} > 50` } },
        // Phase 4 slice 5 (D-80): a locked prefilled value with merge text
        { document_id: doc.id, recipient_id: r.id, type: 'company', page: 1, x: 0.12, y: 0.43, w: 0.3, h: 0.035, required: false, options: { prefill: 'For {{name}}', readonly: true } },
        { document_id: doc.id, recipient_id: r.id, type: 'note', page: 1, x: 0.4, y: 0.24, w: 0.45, h: 0.05, options: { text: 'Please read the terms before signing.' } },
        { document_id: doc.id, recipient_id: r.id, type: 'hyperlink', page: 1, x: 0.12, y: 0.32, w: 0.3, h: 0.03, options: { url: 'https://example.com/terms', label: 'Our terms' } },
        { document_id: doc.id, recipient_id: r.id, type: 'attachment', page: 1, x: 0.5, y: 0.32, w: 0.35, h: 0.04, required: false },
      ] : []),
    ]);
    await rpc(db, 'save_fields', { p_actor: sender.id, p_envelope_id: env.id, p_fields: fields });
    return { id: env.id, recipients: saved, storagePath };
  };

  const draft = await makeEnvelope('Accessibility check (draft)', [SIGNER, { name: 'Bo Second', email: 'a11y-second@example.test' }]);
  // a template to look at (Phase 4 slice 2); earlier runs' templates are removed first so the 100-per-workspace cap is never reached
  const TEMPLATE_NAME = 'Accessibility check template';
  const BULK_TEMPLATE_NAME = 'Accessibility check bulk template';
  const old = await db.rpc('template_list', { p_actor: sender.id, p_org: orgId });
  for (const t of (old.data ?? []).filter((t) => t.name === TEMPLATE_NAME || t.name === BULK_TEMPLATE_NAME)) {
    const { data: oldPath } = await db.rpc('template_delete', { p_actor: sender.id, p_template_id: t.id });
    if (typeof oldPath === 'string') await db.storage.from('originals').remove([oldPath]);
  }
  const templateId = randomUUID();
  const templatePath = `${orgId}/tpl-${templateId}/document.pdf`;
  const copied = await db.storage.from('originals').copy(draft.storagePath, templatePath);
  if (copied.error) throw new Error(`template file copy: ${copied.error.message}`);
  await rpc(db, 'template_create', { p_actor: sender.id, p_template_id: templateId, p_envelope_id: draft.id, p_name: TEMPLATE_NAME, p_shared: true, p_labels: [], p_storage_path: templatePath });
  // Phase 4 slice 9 (D-85): a one-person template for the bulk pages, and a finished batch whose rows all have a problem
  // (so the worker never sends anything for it) to audit the batch page with its table of reasons
  const bulkSource = await makeEnvelope('Accessibility check (bulk source)', [SIGNER], false, true);
  const bulkTemplateId = randomUUID();
  const bulkTemplatePath = `${orgId}/tpl-${bulkTemplateId}/document.pdf`;
  const bulkCopied = await db.storage.from('originals').copy(bulkSource.storagePath, bulkTemplatePath);
  if (bulkCopied.error) throw new Error(`bulk template file copy: ${bulkCopied.error.message}`);
  await rpc(db, 'template_create', { p_actor: sender.id, p_template_id: bulkTemplateId, p_envelope_id: bulkSource.id, p_name: BULK_TEMPLATE_NAME, p_shared: true,
    p_labels: [{ recipient_id: bulkSource.recipients[0].id, label: 'Customer' }], p_storage_path: bulkTemplatePath });
  const batchId = await rpc(db, 'create_bulk_batch', { p_actor: sender.id, p_template_id: bulkTemplateId, p_delivery: 'link', p_expires_days: 30, p_rows: [
    { row_no: 1, name: 'Ada Example', email: 'not-an-email' },
    { row_no: 2, name: '', email: 'a11y-bulk2@example.test' },
    { row_no: 3, name: 'Cy Example', email: 'a11y-bulk3@example.test', values: { qty_0: 'many' } },
  ] });
  // Phase 4 slice 12 (D-88): the workspace has branding, so every signer page is audited with the brand band on it
  await rpc(db, 'set_org_branding', { p_actor: sender.id, p_org: orgId, p_color: '#2F5D50', p_text: 'light', p_footer: 'Accessibility check footer' });
  // Phase 4 slice 11 (D-87): a public form on the one-person template
  const formSlug = randomBytes(16).toString('base64url');
  await rpc(db, 'create_power_form', { p_actor: sender.id, p_template_id: bulkTemplateId, p_title: 'Accessibility check form', p_daily_limit: 5, p_email_check: false, p_slug: formSlug });
  const sendWithLink = async (env) => {
    const tokenId = randomUUID();
    const nonce = newNonce();
    const token = deriveToken(tokenKey, tokenId, nonce);
    // Phase 4 slice 7 (D-83): hand-offs allowed, so the signer pages show "Hand to someone else" and the audit covers it
    await rpc(db, 'set_delegation', { p_actor: sender.id, p_envelope_id: env.id, p_allow: true });
    await rpc(db, 'send_envelope', {
      p_actor: sender.id, p_envelope_id: env.id,
      p_tokens: [{ recipient_id: env.recipients[0].id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
      p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link',
    });
    return token;
  };
  const sent = await makeEnvelope('Accessibility check (signing)', [SIGNER], false, true);
  const token = await sendWithLink(sent);
  // Phase 4 slice 8 (D-84): a question and its answer, so the open "Questions for the sender" panel is audited too
  const qa = await db.from('envelope_comments').insert([
    { org_id: orgId, envelope_id: sent.id, recipient_id: sent.recipients[0].id, author_kind: 'signer', body: 'Is clause 4 negotiable?' },
    { org_id: orgId, envelope_id: sent.id, recipient_id: sent.recipients[0].id, author_kind: 'sender', author_user: sender.id, body: 'Yes, within 10%.' },
  ]);
  if (qa.error) throw new Error(`questions: ${qa.error.message}`);
  const keyboardOnly = await makeEnvelope('Accessibility check (keyboard only)', [{ name: 'Kim Keys', email: 'a11y-keys@example.test' }], true);
  const keyboardToken = await sendWithLink(keyboardOnly);
  // Phase 4 slice 10 (D-86): a document whose only person signs in person (nothing left over from an interrupted run)
  await rpc(db, 'in_person_end_for_host', { p_actor: sender.id });
  const inPerson = await makeEnvelope('Accessibility check (in person)', [{ name: 'Ines Inperson', email: 'a11y-inperson@example.test' }]);
  await rpc(db, 'save_recipients', { p_actor: sender.id, p_envelope_id: inPerson.id,
    p_recipients: [{ id: inPerson.recipients[0].id, name: 'Ines Inperson', email: 'a11y-inperson@example.test', role: 'in_person', routing_order: 1 }] });
  await sendWithLink(inPerson);
  // Phase 5 slice 3 (D-92): one webhook endpoint with a delivery in its log. The ".test" name never resolves and the
  // stored secret is a placeholder, so nothing leaves this PC (the worker records "Not sent").
  for (const e of (await rpc(db, 'webhook_endpoint_list', { p_actor: sender.id, p_org: orgId })) ?? []) await rpc(db, 'webhook_endpoint_delete', { p_actor: sender.id, p_id: e.id });
  const webhookId = randomUUID();
  await rpc(db, 'webhook_endpoint_create', { p_actor: sender.id, p_org: orgId, p_id: webhookId, p_url: 'https://hooks.example.test/a11y', p_description: 'Accessibility check', p_events: ['document.completed', 'person.completed'], p_secret_enc: `v1.${'A'.repeat(60)}` });
  await rpc(db, 'webhook_test', { p_actor: sender.id, p_id: webhookId });
  return { password, draftId: draft.id, sentId: sent.id, token, keyboardToken, templateId, bulkTemplateId, batchId, inPersonId: inPerson.id, formSlug, webhookId };
}

/** Press Tab until the focused element's name matches, then press the key. Fails if it is never reached. */
async function tabTo(page, re, key, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.id || '').trim().replace(/\s+/g, ' ') : '';
    });
    if (re.test(name)) {
      if (key) await page.keyboard.press(key);
      return name;
    }
  }
  throw new Error(`keyboard only: could not reach "${re.source}" with Tab`);
}

const settle = (page, ms = 600) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

async function axeCheck(page, label) {
  await settle(page);
  const has = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!has) await page.evaluate(axeSource);
  const r = await page.evaluate(
    async (tags) => {
      const res = await window.axe.run({ exclude: [['nextjs-portal']] }, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
      const brief = (v) => ({ id: v.id, impact: v.impact, help: v.help, url: v.helpUrl, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), why: n.failureSummary })) });
      return { violations: res.violations.map(brief), incomplete: res.incomplete.map(brief) };
    },
    TAGS,
  );
  const entry = { page: label, url: page.url().replace(/#.*$/, ''), check: 'axe', violations: r.violations, needsReview: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length, help: v.help })) };
  results.push(entry);
  const n = r.violations.reduce((s, v) => s + v.nodes.length, 0);
  say(`  axe        ${label}: ${n === 0 ? 'no violations' : `${n} violation${n === 1 ? '' : 's'} (${r.violations.map((v) => `${v.id}×${v.nodes.length}`).join(', ')})`}${r.incomplete.length ? `; ${r.incomplete.length} rule(s) need a human look` : ''}`);
  if (n) failures.push(`axe: ${label}: ${r.violations.map((v) => v.id).join(', ')}`);
}

async function lighthouseCheck(page, label, url, required) {
  const run = await lighthouse(url, { disableStorageReset: true, onlyCategories: ['accessibility'], output: 'json', logLevel: 'error' }, undefined, page);
  const lhr = run?.lhr;
  const score = Math.round((lhr?.categories?.accessibility?.score ?? 0) * 100);
  const failed = Object.values(lhr?.audits ?? {})
    .filter((a) => a.score === 0 && a.scoreDisplayMode === 'binary')
    .map((a) => a.id);
  results.push({ page: label, url, check: 'lighthouse', score, failedAudits: failed });
  say(`  lighthouse ${label}: ${score}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
  if (required && score < LH_MIN) failures.push(`lighthouse: ${label}: ${score} < ${LH_MIN}`);
  await page.setBypassCSP(true);
}

/** Tab through the page; every stop must be visible and show a focus indicator. */
async function keyboardWalk(page, label, maxStops = 40) {
  // Start from the top of the page, as a keyboard user arriving on it would.
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
    const start = document.createElement('span');
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus();
    start.remove();
  });
  const stops = [];
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
      const r = el.getBoundingClientRect();
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      // WCAG 2.4.11: the focused element must not be entirely hidden (for example under a sticky bar).
      // Probe its centre and four inner points; it is hidden only if something else covers all five.
      const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]);
      const mine = (hit) => !!hit && (hit === el || el.contains(hit) || hit.contains(el) || !!hit.closest('label')?.contains(el));
      const inView = (x, y) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const visible = pts.some(([x, y]) => inView(x, y) && mine(document.elementFromPoint(x, y)));
      return { tag: el.tagName.toLowerCase(), name, ring, visible, size: `${Math.round(r.width)}x${Math.round(r.height)}`, onScreen: r.width > 0 && r.height > 0, key: `${el.tagName}|${name}|${Math.round(r.left)}|${Math.round(r.top + window.scrollY)}` };
    });
    if (!s) break;
    if (stops.length && stops[0].key === s.key) break; // wrapped around
    stops.push(s);
  }
  const bad = stops.filter((s) => !s.ring || !s.onScreen);
  const hidden = stops.filter((s) => s.onScreen && !s.visible);
  const first = stops[0]?.name ?? '';
  results.push({
    page: label, check: 'keyboard', firstStop: first,
    stops: stops.map((s) => ({ tag: s.tag, name: s.name, ring: s.ring, visible: s.visible, size: s.size, onScreen: s.onScreen })),
    missingIndicator: bad.map((s) => `${s.tag} "${s.name}"`), hiddenWhenFocused: hidden.map((s) => `${s.tag} "${s.name}"`),
  });
  say(
    `  keyboard   ${label}: ${stops.length} tab stops${bad.length ? `; ${bad.length} without a visible focus indicator: ${bad.map((s) => `${s.tag} "${s.name}"`).join('; ')}` : ', all with a visible focus indicator'}` +
      `${hidden.length ? `; ${hidden.length} hidden when focused: ${hidden.map((s) => `${s.tag} "${s.name}"`).join('; ')}` : ', none hidden when focused'}; first stop "${first}"`,
  );
  if (!stops.length) failures.push(`keyboard: ${label}: nothing reachable with Tab`);
  if (bad.length) failures.push(`keyboard: ${label}: ${bad.length} stop(s) without focus indicator`);
  if (hidden.length) failures.push(`keyboard: ${label}: ${hidden.length} stop(s) hidden when focused`);
  if (first !== 'Skip to main content') failures.push(`keyboard: ${label}: the first Tab stop is not "Skip to main content"`);
}

/** WCAG 1.4.10: at 320 CSS px wide (400% zoom of 1280) nothing may need sideways scrolling, except the document page itself. */
async function reflowCheck(page, label) {
  const old = page.viewport();
  await page.setViewport({ width: 320, height: 640 });
  await settle(page, 800);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => !el.closest('[data-page], [role="img"], canvas, .signing-surface [aria-label^="Page"]'))
      .filter((el) => el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).position !== 'fixed' && el.getClientRects().length)
      .filter((el) => !el.closest('.sr-only') && !el.classList.contains('skip-link'))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent || '').trim().slice(0, 30)}"`);
    return { scroll: document.documentElement.scrollWidth, vw, wide };
  });
  await page.setViewport(old);
  await settle(page, 500);
  const ok = r.wide.length === 0;
  results.push({ page: label, check: 'reflow-320', ...r, ok });
  say(`  reflow     ${label} at 320 px: ${ok ? 'no sideways scrolling needed' : `content wider than the screen: ${r.wide.join('; ')}`}`);
  if (!ok) failures.push(`reflow: ${label}: content wider than 320 px`);
}

const waitText = (page, re, timeout = 30000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout }, re.source);

const click = async (page, selector) => {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  await el.click();
};

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first, then run this again.`);
  say(`Accessibility audit of ${APP} (axe-core rules: ${TAGS.join(', ')}; Lighthouse target ${LH_MIN})`);
  const t0 = Date.now();
  const data = await prepare();
  say('  test data ready: one draft and one sent synthetic document');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = await browser.newPage();
    pageRef = page;
    await page.setBypassCSP(true); // the audit's own script must not land in the CSP report table
    await page.setViewport({ width: 1280, height: 900 });

    // ---- public pages ----
    say('Public pages');
    for (const [label, p] of [['Sign in', '/login'], ['Create account', '/signup'], ['Check a document (/verify)', '/verify'], ['Join a team (no invitation in the link)', '/join'], ['Public form (PowerForm)', `/f/${data.formSlug}`], ['API documentation (/developers)', '/developers']]) {
      await page.goto(`${APP}${p}`, { waitUntil: 'networkidle0' });
      await axeCheck(page, label);
      await reflowCheck(page, label);
      await lighthouseCheck(page, label, `${APP}${p}`, false);
    }

    // ---- signer path ----
    say('Signer path');
    await page.goto(`${APP}/s#${data.token}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await axeCheck(page, 'Signer: consent');
    await keyboardWalk(page, 'Signer: consent');
    await reflowCheck(page, 'Signer: consent');
    await lighthouseCheck(page, 'Signer: consent', `${APP}/sign`, true);
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await click(page, 'input[name="agree"]');
    await click(page, 'button::-p-text(Agree and continue)');
    await waitText(page, /\d+ of \d+ done/);
    await settle(page, 1500); // the page image
    await axeCheck(page, 'Signer: document');
    await keyboardWalk(page, 'Signer: document');
    await reflowCheck(page, 'Signer: document');
    {
      // WCAG 1.1.1: the pages are pictures; the "Open the document as a PDF" link must give the real file.
      const pdf = await page.evaluate(async () => {
        const a = [...document.querySelectorAll('a')].find((x) => /Open the document as a PDF/.test(x.textContent || ''));
        if (!a) return { found: false };
        const res = await fetch(a.href);
        const head = new Uint8Array(await res.arrayBuffer()).slice(0, 5);
        return { found: true, status: res.status, type: res.headers.get('content-type'), magic: String.fromCharCode(...head) };
      });
      const ok = pdf.found && pdf.status === 200 && pdf.magic === '%PDF-';
      results.push({ page: 'Signer: document as a PDF (text alternative)', check: 'pdf-link', ...pdf, ok });
      say(`  pdf link   Signer: "Open the document as a PDF" ${ok ? `gives the PDF (${pdf.type})` : `FAILED ${JSON.stringify(pdf)}`}`);
      if (!ok) failures.push('pdf link: the signer cannot open the document as a PDF');
    }
    await lighthouseCheck(page, 'Signer: document', `${APP}/sign`, true);
    await waitText(page, /\d+ of \d+ done/);
    await settle(page, 1500);

    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await settle(page, 800);
    await axeCheck(page, 'Signer: document at phone width (375 px)');
    await page.setViewport({ width: 1280, height: 900 });
    await settle(page, 800);

    await click(page, 'button[aria-label^="Sign here"]');
    await page.waitForSelector('[role="tablist"]', { visible: true, timeout: 15000 });
    await axeCheck(page, 'Signer: signature dialog (Draw)');
    await click(page, '[role="tab"]::-p-text(Type)');
    await page.waitForSelector('#sig-typed', { visible: true });
    await page.click('#sig-typed', { count: 3 }); // the box starts with the signer's name; replace it
    await page.type('#sig-typed', SIGNER.name);
    await axeCheck(page, 'Signer: signature dialog (Type)');
    await click(page, 'button::-p-text(Use this signature)');
    await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await click(page, 'button::-p-text(Finish)');
    await page.waitForSelector('#finish-title', { visible: true });
    await axeCheck(page, 'Signer: confirm and sign dialog');
    await click(page, 'button::-p-text(Adopt and Sign)');
    await page.waitForFunction(() => !document.querySelector('#finish-title'), { timeout: 30000 });
    await settle(page, 2500);
    await axeCheck(page, 'Signer: after signing');
    await lighthouseCheck(page, 'Signer: after signing', `${APP}/sign`, true);

    // ---- a second signer who uses the keyboard only (no mouse at all) ----
    say('Signer path, keyboard only');
    {
      const steps = [];
      await page.goto(`${APP}/s#${data.keyboardToken}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
      await page.evaluate(() => document.activeElement?.blur?.());
      steps.push(await tabTo(page, /^agree$/, 'Space'));
      steps.push(await tabTo(page, /^Agree and continue$/, 'Enter'));
      await waitText(page, /\d+ of \d+ done/);
      await settle(page, 1500);
      steps.push(await tabTo(page, /^Sign here/, 'Enter'));
      await page.waitForSelector('[role="tablist"]', { visible: true, timeout: 15000 });
      steps.push(await tabTo(page, /^Type$/, 'Enter'));
      await page.waitForSelector('#sig-typed', { visible: true });
      steps.push(await tabTo(page, /^sig-typed$/, null)); // the box starts with the signer's name, which is fine to keep
      steps.push(await tabTo(page, /^Use this signature$/, 'Enter'));
      await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
      steps.push(await tabTo(page, /^Text \(required\)$/, null));
      await page.keyboard.type('Typed with the keyboard only');
      steps.push(await tabTo(page, /^Finish$/, 'Enter'));
      await page.waitForSelector('#finish-title', { visible: true });
      steps.push(await tabTo(page, /^Adopt and Sign$/, 'Enter'));
      await page.waitForFunction(() => !document.querySelector('#finish-title'), { timeout: 30000 });
      await settle(page, 2000);
      const signed = await page.evaluate(() => !document.querySelector('button[aria-label^="Sign here"]') && !/Finish/.test(document.body.innerText));
      results.push({ page: 'Signer: whole signing with the keyboard only', check: 'keyboard-only', steps, ok: signed });
      say(`  keyboard   Signer: signed with Tab, Space and Enter only: ${signed ? 'yes' : 'NO'} (${steps.length} steps)`);
      if (!signed) failures.push('keyboard only: the signing did not finish');
    }

    // ---- sender path ----
    say('Sender path');
    await page.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await page.type('#email', SENDER_EMAIL);
    await page.type('#password', data.password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('form button[type="submit"]')]);
    if (!page.url().includes('/app')) throw new Error(`sign-in did not reach the app (now at ${page.url().replace(APP, '')})`);
    const senderPages = [
      ['Sender: documents (dashboard)', '/app'],
      ['Sender: new document (upload)', '/app/new'],
      ['Sender: draft (people, fields, send)', `/app/envelopes/${data.draftId}`],
      ['Sender: signed document', `/app/envelopes/${data.sentId}`],
      ['Sender: folders', '/app/folders'],
      ['Sender: notifications', '/app/notifications'],
      ['Sender: settings', '/app/settings'],
      ['Sender: webhooks and a delivery log', `/app/settings/webhooks?log=${data.webhookId}`],
      ['Sender: reports (last 30 days)', '/app/reports'],
      ['Sender: sign-in security', '/app/account/security'],
      ['Sender: team', '/app/team'],
      ['Sender: templates', '/app/templates'],
      ['Sender: a template (use and edit)', `/app/templates/${data.templateId}`],
      ['Sender: a one-person template (public form section)', `/app/templates/${data.bulkTemplateId}`],
      ['Sender: bulk send (choose a file)', `/app/templates/${data.bulkTemplateId}/bulk`],
      ['Sender: a bulk batch (rows and reasons)', `/app/bulk/${data.batchId}`],
    ];
    for (const [label, p] of senderPages) {
      await page.goto(`${APP}${p}`, { waitUntil: 'networkidle0' });
      await settle(page, 1200);
      await axeCheck(page, label);
      await reflowCheck(page, label);
      if (p === `/app/templates/${data.bulkTemplateId}/bulk`) {
        // the preview after choosing a file: counts, rows with a problem, the first rows, delivery and expiry choices
        const csvPath = path.join(tmpdir(), `a11y-bulk-${randomUUID()}.csv`);
        writeFileSync(csvPath, 'name,email,qty_0\r\nAda Example,a11y-ada@example.test,3\r\nBo Example,not-an-email,4\r\n');
        await (await page.$('#bulk-file')).uploadFile(csvPath);
        await page.waitForFunction(() => /ready, \d+ with a problem/.test(document.body.innerText), { timeout: 15000 });
        await click(page, 'input[name="bulk-delivery"]:not(:checked)');
        await settle(page, 600);
        await axeCheck(page, 'Sender: bulk send (preview of a file, by email)');
        await reflowCheck(page, 'Sender: bulk send (preview of a file, by email)');
      }
      if (p === `/app/envelopes/${data.draftId}`) {
        await keyboardWalk(page, label, 80);
        // A placed field, selected with one click; then the click-only Move / Wider buttons (WCAG 2.5.7) must change it.
        const fieldSel = '[role="button"][aria-label*="Delete removes it"]';
        await click(page, fieldSel);
        await page.waitForSelector('[role="group"][aria-label="Move or resize the selected field"]', { visible: true, timeout: 10000 });
        await axeCheck(page, 'Sender: draft with a field selected');
        const box = () => page.$eval(`${fieldSel}[aria-pressed="true"]`, (el) => ({ left: el.style.left, width: el.style.width }));
        const before = await box();
        await click(page, 'button[aria-label="Move right"]');
        await click(page, 'button[aria-label="Wider"]');
        await settle(page, 300);
        const after = await box();
        const moved = parseFloat(after.left) > parseFloat(before.left) && parseFloat(after.width) > parseFloat(before.width);
        results.push({ page: 'Sender: field moved and resized by clicks only', check: 'single-pointer', before, after, ok: moved });
        say(`  clicks     Sender: field moved and resized without dragging: ${moved ? 'yes' : 'NO'} (left ${before.left} -> ${after.left}, width ${before.width} -> ${after.width})`);
        if (!moved) failures.push('single-pointer: the Move/Wider buttons did not change the field');
        await waitText(page, /All changes saved/, 20000); // otherwise the "unsaved changes" warning holds the next page

        // WCAG 2.1.1: a new field can be placed and positioned with the keyboard only.
        const count = () => page.$$eval(fieldSel, (els) => els.length);
        const n0 = await count();
        await page.evaluate(() => document.activeElement?.blur?.());
        const steps = [];
        steps.push(await tabTo(page, /^Signature$/, 'Enter', 80));
        steps.push(await tabTo(page, /^Place Signature on page 1$/, 'Enter', 80));
        await settle(page, 400);
        const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
        await page.keyboard.press('ArrowDown');
        await settle(page, 300);
        const n1 = await count();
        const kbOk = n1 === n0 + 1 && /^Signature/.test(focused);
        results.push({ page: 'Sender: field placed with the keyboard only', check: 'keyboard-only', steps, focusedAfterPlacing: focused, fieldsBefore: n0, fieldsAfter: n1, ok: kbOk });
        say(`  keyboard   Sender: new field placed and moved with the keyboard only: ${kbOk ? 'yes' : 'NO'} (fields ${n0} -> ${n1}; focus on "${focused.slice(0, 40)}")`);
        if (!kbOk) failures.push('keyboard only: could not place a field with the keyboard');
        await waitText(page, /All changes saved/, 20000);
      }
      if (p === '/app') await lighthouseCheck(page, label, `${APP}${p}`, false);
    }

    // ---- in-person signing on a tablet-width screen (D-86, AT4.7) ----
    say('In-person signing (tablet width, 768 px)');
    {
      const PIN = '4071';
      await page.setViewport({ width: 768, height: 1024 });
      await page.goto(`${APP}/app/envelopes/${data.inPersonId}`, { waitUntil: 'networkidle0' });
      await settle(page, 800);
      await click(page, 'button::-p-text(Start signing in person)');
      await page.waitForSelector('dialog[open] input[type="password"]', { visible: true, timeout: 10000 });
      await axeCheck(page, 'Sender: start signing in person (dialog)');
      const pins = await page.$$('dialog[open] input[type="password"]');
      await pins[0].type(PIN);
      await pins[1].type(PIN);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), click(page, 'button::-p-text(Hand the device to Ines Inperson)')]);
      await waitText(page, /Signing in person with/, 20000);
      await settle(page, 1200);
      await axeCheck(page, 'In person: signing screen with the host banner');
      await reflowCheck(page, 'In person: signing screen with the host banner');
      await lighthouseCheck(page, 'In person: signing screen with the host banner', `${APP}/sign`, true);
      await click(page, 'button::-p-text(Lock the screen)');
      await waitText(page, /The screen is locked/, 20000);
      await settle(page, 600);
      await axeCheck(page, 'In person: locked screen (host PIN)');
      await reflowCheck(page, 'In person: locked screen (host PIN)');
      await page.goto(`${APP}/app`, { waitUntil: 'networkidle0' });
      if (!page.url().includes('/in-person')) failures.push('in person: the host account did not ask for the PIN');
      await settle(page, 600);
      await axeCheck(page, 'Host: in-person signing in progress (PIN page)');
      await reflowCheck(page, 'Host: in-person signing in progress (PIN page)');
      await page.type('#return-pin', PIN);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), click(page, 'button::-p-text(Return to my account)')]);
      if (!page.url().includes(`/app/envelopes/${data.inPersonId}`)) failures.push('in person: the PIN did not return the host to the document');
      await page.setViewport({ width: 1280, height: 900 });
    }
  } catch (e) {
    if (process.env.A11Y_DEBUG_SHOT && pageRef) await pageRef.screenshot({ path: process.env.A11Y_DEBUG_SHOT, fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }

  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  const outDir = path.join(appDir, '..', 'exports', 'phase3', 'a11y');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, 'Z');
  writeFileSync(path.join(outDir, `a11y-${stamp}.json`), JSON.stringify({ app: APP, tags: TAGS, lighthouseTarget: LH_MIN, ranAt: new Date().toISOString(), results, failures }, null, 2) + '\n');
  say('');
  if (failures.length) {
    say(`ACCESSIBILITY AUDIT FAILED (${failures.length}) in ${seconds} s:`);
    for (const f of failures) say(`  - ${f}`);
  } else say(`ACCESSIBILITY AUDIT PASSED in ${seconds} s.`);
  say(`Full results: exports\\phase3\\a11y\\a11y-${stamp}.json`);
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  const shot = process.env.A11Y_DEBUG_SHOT;
  if (shot && pageRef) await pageRef.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.error(`ACCESSIBILITY AUDIT could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
