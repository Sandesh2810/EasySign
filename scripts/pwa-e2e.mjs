// npm run e2e:pwa [-- --app http://localhost:3000]
// End-to-end check of the installable signer pages (Phase 5 slice 7, D-96), in its own synthetic workspace: the
// manifest and its icons are served and complete; opening a signing link installs the service worker; after reading
// and signing a document the device's storage holds only the offline page and two icons (no page, no document, no
// signature, no answer); without a connection a signing page shows the offline page, while the document, the API and
// the sender's app are not served from the device; with the connection back, signing pages work as before.
// Needs the app AND the background worker running.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = (argAt('--app') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = path.resolve(appDir, '..', 'exports', 'phase5');
const OWNER = { email: 'pwa-owner@example.test', name: 'Pia Pwa' };
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const tag = randomBytes(3).toString('hex');
const SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
async function api(key, method, p, body) {
  const res = await fetch(`${APP}${p}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const stored = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    return out.sort();
  });

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Installable signer pages end-to-end check against ${APP}`);
  mkdirSync(OUT, { recursive: true });

  // ---------- manifest and icons ----------
  const manifest = await fetch(`${APP}/manifest.webmanifest`).then((r) => r.json());
  const icons = await Promise.all(
    (manifest.icons ?? []).map(async (i) => {
      const res = await fetch(`${APP}${i.src}`);
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      return { ...i, ok: res.ok && res.headers.get('content-type') === 'image/png' && `${meta.width}x${meta.height}` === i.sizes };
    }),
  );
  const head = await fetch(`${APP}/sign`).then((r) => r.text());
  check('the manifest names the app, opens the signing page, runs standalone and lists icons that exist at their stated sizes (including a maskable one)',
    manifest.name === 'YouNMeSign signing' && manifest.start_url === '/sign' && manifest.display === 'standalone' && icons.length === 3 && icons.every((i) => i.ok)
      && icons.some((i) => i.purpose === 'maskable') && head.includes('<link rel="manifest" href="/manifest.webmanifest"'),
    icons.map((i) => `${i.sizes}${i.purpose === 'maskable' ? ' maskable' : ''}:${i.ok ? 'ok' : 'BAD'}`).join(', '));
  const sw = await fetch(`${APP}/sw.js`);
  check('the service worker is always fetched fresh', /no-store/.test(sw.headers.get('cache-control') ?? '') && /javascript/.test(sw.headers.get('content-type') ?? ''));

  // ---------- a document to sign ----------
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const org = (await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single()).data.org_id;
  for (const k of (await rpc(db, 'api_key_list', { p_actor: u.id, p_org: org })).filter((k) => !k.revoked_at)) await rpc(db, 'revoke_api_key', { p_actor: u.id, p_key_id: k.id });
  const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: `PWA source ${tag}`, p_folder_id: null });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Private contract ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const src = `${org}/${env.id}/doc1.pdf`;
  await db.storage.from('originals').upload(src, bytes, { contentType: 'application/pdf', upsert: false });
  const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'p.pdf', p_storage_backend: 'supabase', p_storage_path: src,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
  const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Party', email: `pwa-party-${tag}@example.test`, role: 'signer', routing_order: 1 }] });
  await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  const templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  await db.storage.from('originals').copy(src, tplPath);
  await rpc(db, 'template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `PWA ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Party' }], p_storage_path: tplPath });
  const key = `ynms_${randomBytes(32).toString('base64url')}`;
  await rpc(db, 'create_api_key', { p_actor: u.id, p_org: org, p_name: `PWA ${tag}`, p_scopes: ['documents:read', 'documents:write', 'documents:send'], p_prefix: key.slice(0, 12), p_key_sha256: createHash('sha256').update(key).digest('hex') });
  const created = await api(key, 'POST', '/api/v1/documents', { template_id: templateId, people: [{ role: 'Party', name: 'Paz Party', email: `pwa-paz-${tag}@example.test` }] });
  const link = (await api(key, 'POST', `/api/v1/documents/${created.data.id}/send`, { delivery: 'link' })).data?.signing_links?.[0]?.url;
  if (!link) throw new Error('could not send the test document');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setBypassCSP(true);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(link, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="agree"]', { timeout: 30000 });
    const ready = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 15000))]);
      return reg ? { scope: new URL(reg.scope).pathname, active: Boolean(reg.active) } : null;
    });
    check('opening a signing link installs the service worker', ready?.active === true && ready.scope === '/', JSON.stringify(ready));

    // read and sign
    await page.click('input[name="agree"]');
    await page.click('button::-p-text(Agree and continue)');
    await page.waitForSelector('button[data-field-kind="signature"]', { timeout: 30000 });
    await new Promise((res) => setTimeout(res, 1500)); // the document is drawn
    await page.click('button[data-field-kind="signature"]');
    await page.waitForSelector('[role="tablist"]', { visible: true });
    await page.click('[role="tab"]::-p-text(Type)');
    await page.click('button::-p-text(Use this signature)');
    await page.waitForSelector('button[aria-label*="is in place"]', { timeout: 20000 });
    await page.click('button::-p-text(Finish)');
    await page.waitForSelector('#finish-title', { visible: true });
    await page.click('button::-p-text(Adopt and Sign)');
    await page.waitForFunction(() => /Thank you/.test(document.body.innerText), { timeout: 30000 });
    const kept = await stored(page);
    check('after reading and signing, the device keeps only the offline page and two icons: no page, document, signature or answer',
      JSON.stringify(kept) === JSON.stringify([...SHELL].sort()), kept.join(', '));

    // ---------- offline ----------
    // the page and the service worker are separate in the browser: both are taken offline
    const swTarget = await ctx.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
    const swSession = await swTarget.createCDPSession();
    await swSession.send('Network.enable');
    const offline = (on) => swSession.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await offline(true);
    await page.setOfflineMode(true);
    await page.goto(`${APP}/sign`, { waitUntil: 'load' }).catch(() => undefined);
    const offlineText = await page.evaluate(() => document.body?.innerText ?? '');
    const offlineLang = await page.evaluate(() => [...document.querySelectorAll('section[lang]')].map((s) => s.getAttribute('lang')).join(','));
    await page.screenshot({ path: path.join(OUT, 'pwa-offline.png'), fullPage: true });
    check('without a connection a signing page shows the offline page, in all four languages', /You are offline/.test(offlineText) && offlineLang === 'en,es,hi,ar', `${offlineLang} | ${offlineText.slice(0, 60).replace(/\s+/g, ' ')}`);
    const docOffline = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/sign/document');
        return `served ${r.status}`;
      } catch {
        return 'not available';
      }
    });
    let appOffline = 'not available';
    try {
      await page.goto(`${APP}/app`, { waitUntil: 'load' });
      appOffline = /You are offline/.test(await page.evaluate(() => document.body?.innerText ?? '')) ? 'offline page' : 'served';
    } catch {
      appOffline = 'not available';
    }
    check('without a connection the document is not served from the device, and the sender\u2019s app is not touched', docOffline === 'not available' && appOffline === 'not available', `document: ${docOffline}; app: ${appOffline}`);
    await offline(false);
    await page.setOfflineMode(false);
    await page.goto(`${APP}/sign`, { waitUntil: 'networkidle0' });
    const back = await page.evaluate(() => document.body?.innerText ?? '');
    check('with the connection back, the signing page comes from the app again (not the offline page)', !/You are offline/.test(back) && /Thank you|signed|complete/i.test(back), back.slice(0, 60).replace(/\n/g, ' '));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `PWA E2E FAILED (${failed} of ${results.length})` : `PWA E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`PWA E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
