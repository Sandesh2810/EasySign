// npm run e2e:languages [-- --app http://localhost:3000]
// End-to-end check of the signer's languages (Phase 5 slice 6, AT5.6 automated part, D-95), in its own synthetic
// workspace. A document is created and sent over the API; its link is opened by a browser that prefers Arabic:
// the page is Arabic and right to left (the RTL layout snapshot: the page's direction, the header and the consent
// box mirrored, nothing wider than the screen at desktop and phone width, screenshots and a layout record saved in
// exports\phase5), while the legal text stays in English and says so. The language menu then switches to Spanish:
// the choice is kept (cookie) and stored with the person (for their emails); the document is signed in Spanish.
// Needs the app AND the background worker running.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const OUT = path.resolve(appDir, '..', 'exports', 'phase5');
const OWNER = { email: 'lang-owner@example.test', name: 'Lena Lang' };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const tag = randomBytes(3).toString('hex');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const ARABIC = /[\u0600-\u06FF]/;

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
async function api(key, method, p, body) {
  const res = await fetch(`${APP}${p}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Layout facts of the consent page: what mirrors in right to left, and whether anything is wider than the screen. */
const layoutFacts = (page) =>
  page.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect() : null);
    const shell = document.querySelector('main')?.parentElement;
    const header = shell?.querySelector('header');
    const brand = box(header?.querySelector('p'));
    const menu = box(header?.querySelector('form'));
    const agree = document.querySelector('input[name="agree"]');
    const agreeBox = box(agree);
    const agreeText = box(agree?.parentElement?.querySelector('span'));
    const legal = document.querySelector('main [lang="en"][dir="ltr"]');
    return {
      lang: shell?.getAttribute('lang'),
      dir: shell?.getAttribute('dir'),
      computedDirection: shell ? getComputedStyle(shell).direction : null,
      brandRight: brand?.right ?? null,
      menuRight: menu?.right ?? null,
      checkboxLeftOfText: agreeBox && agreeText ? agreeBox.left < agreeText.left : null,
      legalDirection: legal ? getComputedStyle(legal).direction : null,
      legalTextAlign: legal ? getComputedStyle(legal).textAlign : null,
      heading: document.querySelector('main h1')?.textContent ?? '',
      uiHeading: document.querySelector('main h2')?.textContent ?? '',
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Languages end-to-end check against ${APP}`);
  mkdirSync(OUT, { recursive: true });
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const org = (await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single()).data.org_id;
  for (const k of (await rpc(db, 'api_key_list', { p_actor: u.id, p_org: org })).filter((k) => !k.revoked_at)) await rpc(db, 'revoke_api_key', { p_actor: u.id, p_key_id: k.id });

  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Language source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Contract ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const src = `${org}/${env.id}/doc1.pdf`;
  await db.storage.from('originals').upload(src, bytes, { contentType: 'application/pdf', upsert: false });
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'c.pdf', p_storage_backend: 'supabase', p_storage_path: src,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Party', email: `lang-party-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  await db.storage.from('originals').copy(src, tplPath);
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `Language ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Party' }], p_storage_path: tplPath });
  const key = `ynms_${randomBytes(32).toString('base64url')}`;
  await rpc(db, 'create_api_key', { p_actor: u.id, p_org: org, p_name: `Lang ${tag}`, p_scopes: ['documents:read', 'documents:write', 'documents:send'], p_prefix: key.slice(0, 12), p_key_sha256: createHash('sha256').update(key).digest('hex') });
  const created = await api(key, 'POST', '/api/v1/documents', { template_id: templateId, title: `Acuerdo ${tag}`, people: [{ role: 'Party', name: 'Amal Arabi', email: `lang-amal-${tag}@example.test` }] });
  const sent = await api(key, 'POST', `/api/v1/documents/${created.data.id}/send`, { delivery: 'link' });
  const link = sent.data?.signing_links?.[0]?.url;
  if (!link) throw new Error(`could not send the test document (${created.status}/${sent.status})`);
  const personId = sent.data.document.people[0].id;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setBypassCSP(true);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar-EG,ar;q=0.9,en;q=0.5' });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(link, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });

    // ---------- the RTL layout snapshot ----------
    const desktop = await layoutFacts(page);
    await page.screenshot({ path: path.join(OUT, 'rtl-consent-desktop.png'), fullPage: true });
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    const phone = await layoutFacts(page);
    await page.screenshot({ path: path.join(OUT, 'rtl-consent-phone.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 900 });
    writeFileSync(path.join(OUT, 'rtl-layout.json'), JSON.stringify({ at: new Date().toISOString(), desktop, phone }, null, 2));
    check('a browser preferring Arabic gets the page in Arabic, right to left', desktop.lang === 'ar' && desktop.dir === 'rtl' && desktop.computedDirection === 'rtl' && ARABIC.test(desktop.uiHeading), desktop.uiHeading);
    check('the layout is mirrored: the product name is on the right of the header, the language menu on the left, the tick box on the right of its words',
      desktop.brandRight > desktop.menuRight && desktop.checkboxLeftOfText === false, `brand right ${Math.round(desktop.brandRight)} > menu right ${Math.round(desktop.menuRight)}`);
    check('the legal text stays English, left to right, and the page says so in Arabic',
      desktop.legalDirection === 'ltr' && (await page.$eval('main', (m) => m.innerText)).includes('النص القانوني أدناه باللغة الإنجليزية'));
    check('nothing is wider than the screen, on a desktop or a 375 px phone', desktop.scrollWidth <= desktop.clientWidth && phone.scrollWidth <= phone.clientWidth, `phone ${phone.scrollWidth}/${phone.clientWidth}`);
    const stored = (await db.from('recipients').select('locale').eq('id', personId).single()).data?.locale;
    check('the language the person reads in is stored with them, for their emails', stored === 'ar', `locale=${stored}`);

    // ---------- the language menu ----------
    await page.select('#signer-language', 'es');
    await page.click('header form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('main')?.parentElement?.getAttribute('lang') === 'es', { timeout: 20000 });
    const es = await layoutFacts(page);
    await page.reload({ waitUntil: 'networkidle0' });
    const afterReload = await layoutFacts(page);
    const storedEs = (await db.from('recipients').select('locale').eq('id', personId).single()).data?.locale;
    check('choosing Español in the menu switches the page to Spanish, left to right, and it stays after a reload (even though the browser prefers Arabic)',
      es.dir === 'ltr' && afterReload.lang === 'es' && (await page.$eval('form button[type="submit"]:not(header *)', (b) => b.textContent)) === 'Aceptar y continuar', `heading "${afterReload.heading}"`);
    check('the chosen language is stored with the person', storedEs === 'es', `locale=${storedEs}`);

    // ---------- signing in Spanish ----------
    await page.click('input[name="agree"]');
    await page.click('form button[type="submit"]:not(header *)');
    await page.waitForSelector('button[data-field-kind="signature"]', { timeout: 30000 });
    const signLabel = await page.$eval('button[data-field-kind="signature"]', (b) => b.textContent?.trim());
    await page.click('button[data-field-kind="signature"]');
    await page.waitForSelector('[role="tablist"]', { visible: true });
    const tabs = await page.$$eval('[role="tab"]', (ts) => ts.map((x) => x.textContent?.trim()));
    await page.click('[role="tab"]::-p-text(Escribir)');
    await page.click('button::-p-text(Usar esta firma)');
    await page.waitForSelector('button[aria-label*="está colocada"]', { timeout: 20000 });
    await page.click('button::-p-text(Terminar)');
    await page.waitForSelector('#finish-title', { visible: true });
    const dialog = await page.$eval('#finish-title', (h) => ({ title: h.textContent, legalNote: h.parentElement?.innerText.includes('La declaración anterior está en inglés') ?? false, intentLang: h.parentElement?.querySelector('p[lang="en"]') !== null }));
    await page.screenshot({ path: path.join(OUT, 'es-confirm.png') });
    await page.click('button::-p-text(Adoptar y firmar)');
    await page.waitForFunction(() => /Gracias/.test(document.body.innerText), { timeout: 30000 });
    check('the signing room, the signature dialog and the confirmation are in Spanish; the statement being confirmed stays English and says so',
      signLabel === 'Firme aquí' && tabs.join('|') === 'Dibujar|Escribir|Subir' && dialog.title === 'Firmar este documento' && dialog.legalNote && dialog.intentLang, `${signLabel} / ${tabs.join(',')}`);
    let status = null;
    for (let i = 0; i < 40 && status !== 'completed'; i++) {
      status = (await api(key, 'GET', `/api/v1/documents/${created.data.id}`)).data?.status;
      if (status !== 'completed') await new Promise((res) => setTimeout(res, 2000));
    }
    check('the document signed in Spanish is completed and sealed', status === 'completed', `status=${status}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `LANGUAGES E2E FAILED (${failed} of ${results.length})` : `LANGUAGES E2E PASSED (${results.length} checks); screenshots and the layout record in exports\\phase5`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`LANGUAGES E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
