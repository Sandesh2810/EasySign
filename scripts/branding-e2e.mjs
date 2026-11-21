// npm run e2e:branding [-- --app http://localhost:3000]
// End-to-end check of workspace branding (Phase 4 slice 12, AT4.8, D-88) through the real pages and the worker's own
// email code:
// * in Settings an unreadable colour pair is explained and cannot be saved; a readable one is saved with a footer;
// * a PNG logo is accepted (served back unchanged); an SVG disguised as a PNG is refused;
// * the email a signer would get (built by the worker's code, nothing sent) carries the band, button colours and footer;
// * the signer page shows the workspace's logo and name on its colour above the neutral signing area;
// * switching branding off removes it from the signer page and removes the logo file.
// Needs the app running. Synthetic accounts only. Signs in once.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
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
const OWNER = { email: 'brand-owner@example.test', name: 'Bree Brand' };
const COLOR = '#2F5D50';
const FOOTER = `Acme Lettings Ltd, 1 High Street (${randomBytes(2).toString('hex')})`;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
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

/** A real 24x24 PNG in the brand colour (built by hand: signature, IHDR, IDAT, IEND). */
function makePng() {
  const w = 24;
  const h = 24;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [0x2f, 0x5d, 0x50]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function setColour(page, color, text) {
  await page.click('#brand-color', { count: 3 });
  await page.type('#brand-color', color);
  await page.click(`input[name="brand-text"]:nth-of-type(1)`).catch(() => null);
  const radios = await page.$$('input[name="brand-text"]');
  await radios[text === 'light' ? 0 : 1].click();
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome (or Microsoft Edge) is not installed in the usual place.');
  if (!(await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false))) throw new Error(`The app is not running at ${APP}.`);
  console.log(`Workspace branding end-to-end check against ${APP}`);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(24).toString('base64url');
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === OWNER.email);
  if (!u) u = (await db.auth.admin.createUser({ email: OWNER.email, password, email_confirm: true, user_metadata: { full_name: OWNER.name } })).data.user;
  else await db.auth.admin.updateUserById(u.id, { password });
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m.org_id;
  const { data: orgRow } = await db.from('organizations').select('name').eq('id', org).single();
  await rpc(db, 'clear_org_branding', { p_actor: u.id, p_org: org }); // start plain
  const dir = mkdtempSync(path.join(tmpdir(), 'ynms-brand-'));
  const pngPath = path.join(dir, 'logo.png');
  const png = makePng();
  writeFileSync(pngPath, png);
  const fakePath = path.join(dir, 'sneaky.png');
  writeFileSync(fakePath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000 });
  try {
    const owner = await browser.newPage();
    await owner.setBypassCSP(true);
    await owner.setViewport({ width: 1280, height: 1000 });
    await owner.goto(`${APP}/login`, { waitUntil: 'networkidle0' });
    await owner.type('#email', OWNER.email);
    await owner.type('#password', password);
    await Promise.all([owner.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), owner.click('form button[type="submit"]')]);

    // ---------- unreadable is blocked; readable is saved ----------
    await owner.goto(`${APP}/app/settings`, { waitUntil: 'networkidle0' });
    await setColour(owner, '#FFD400', 'light');
    const blockedText = await owner.$eval('#brand-contrast', (e) => e.textContent ?? '');
    const saveDisabled = await owner.$eval('xpath/.//button[normalize-space()="Save branding"]', (b) => b.disabled);
    check('an unreadable colour pair (light text on yellow) is explained and cannot be saved', /hard to read/.test(blockedText) && /Dark text would work/.test(blockedText) && saveDisabled, blockedText.slice(0, 90));
    await setColour(owner, COLOR, 'light');
    await owner.type('#brand-footer', FOOTER);
    await owner.click('button::-p-text(Save branding)');
    await owner.waitForFunction(() => document.body.innerText.includes('Saved. New signing pages'), { timeout: 20000 });
    const { data: saved } = await db.from('org_branding').select('brand_color, text_on_brand, email_footer').eq('org_id', org).single();
    check('a readable colour pair and a footer are saved', saved?.brand_color === COLOR && saved.text_on_brand === 'light' && saved.email_footer === FOOTER);

    // ---------- logo ----------
    await owner.waitForSelector('#brand-logo', { timeout: 20000 });
    await (await owner.$('#brand-logo')).uploadFile(fakePath);
    await owner.click('button::-p-text(Upload the logo)');
    await owner.waitForFunction(() => document.body.innerText.includes('must be a PNG or JPEG'), { timeout: 20000 });
    const { data: noLogo } = await db.from('org_branding').select('logo_storage_path').eq('org_id', org).single();
    await (await owner.$('#brand-logo')).uploadFile(pngPath);
    await owner.click('button::-p-text(Upload the logo)');
    await owner.waitForFunction(() => document.body.innerText.includes('Logo saved'), { timeout: 20000 });
    const { data: withLogo } = await db.from('org_branding').select('logo_storage_path, logo_sha256').eq('org_id', org).single();
    const served = await fetch(`${APP}/api/brand/${org}/logo?v=1`);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    check('an SVG disguised as a PNG is refused; a real PNG logo is stored and served back unchanged',
      noLogo?.logo_storage_path === null && served.status === 200 && served.headers.get('content-type') === 'image/png' && servedBytes.equals(png)
        && withLogo?.logo_sha256 === createHash('sha256').update(png).digest('hex'));

    // ---------- a document from this workspace, sent by email ----------
    const env = await rpc(db, 'create_envelope', { p_actor: u.id, p_org_id: org, p_title: 'Branded lease', p_folder_id: null });
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText(`Branded ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const bytes = await pdf.save();
    const storagePath = `${org}/${env.id}/doc1.pdf`;
    await db.storage.from('originals').upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
    const doc = await rpc(db, 'add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'lease.pdf', p_storage_backend: 'supabase', p_storage_path: storagePath,
      p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' });
    const [r] = await rpc(db, 'save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Rita Renter', email: `e2e-rita-${randomBytes(2).toString('hex')}@example.test`, role: 'signer', routing_order: 1 }] });
    await rpc(db, 'save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
    const tokenId = randomUUID();
    const nonce = newNonce();
    const token = deriveToken(process.env.SIGNER_TOKEN_KEY, tokenId, nonce);
    await rpc(db, 'send_envelope', { p_actor: u.id, p_envelope_id: env.id, p_tokens: [{ recipient_id: r.id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
      p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'email' });
    const { data: out } = await db.from('notification_outbox').select('id').eq('recipient_id', r.id).eq('kind', 'signature_request').single();
    const preview = JSON.parse(execFileSync(process.execPath, ['--env-file=.env.local', 'scripts/outbox-preview.mjs', out.id, '--json'], { encoding: 'utf8' }).trim().split('\n').at(-1));
    const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const parts = {
      band: preview.html.includes(`background:${COLOR};color:#FFFFFF;padding:12px 16px`),
      name: preview.html.includes(escHtml(orgRow.name)),
      button: /<a href="[^"]+" style="display:inline-block;background:#2F5D50;color:#FFFFFF;/.test(preview.html),
      footer: preview.html.includes(escHtml(FOOTER)),
      textFooter: preview.text.trim().endsWith(FOOTER),
    };
    check('the signer\u2019s email (built by the worker\u2019s code) carries the workspace name on its colour, the button in its colours, and the footer',
      Object.values(parts).every(Boolean), Object.entries(parts).filter(([, v]) => !v).map(([k]) => `missing ${k}`).join(', '));

    // ---------- the signer page ----------
    const signer = await (await browser.createBrowserContext()).newPage();
    await signer.setBypassCSP(true);
    await signer.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await signer.goto(`${APP}/s#${token}`, { waitUntil: 'networkidle0' });
    await signer.waitForSelector('input[name="agree"]', { timeout: 30000 });
    await signer.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => null);
    const band = await signer.evaluate(() => {
      const b = document.querySelector('[data-brand-band]');
      const img = b?.querySelector('img');
      return b ? { bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color, text: b.textContent?.trim() ?? '', logo: img ? img.complete && img.naturalWidth > 0 : false } : null;
    });
    check('the signer page shows the workspace\u2019s logo and name on its colour above the signing area',
      band?.bg === 'rgb(47, 93, 80)' && band.color === 'rgb(255, 255, 255)' && band.text.includes(orgRow.name) && band.logo, JSON.stringify(band));

    // ---------- switching it off ----------
    await owner.reload({ waitUntil: 'networkidle0' });
    await owner.click('button::-p-text(Switch branding off)');
    await owner.waitForFunction(() => document.body.innerText.includes('Branding switched off'), { timeout: 20000 });
    await signer.reload({ waitUntil: 'networkidle0' });
    await signer.waitForSelector('input[name="agree"]', { timeout: 30000 });
    const bandAfter = await signer.$('[data-brand-band]');
    const logoGone = (await db.storage.from('branding').download(withLogo.logo_storage_path)).error !== null;
    check('switching branding off removes it from the signer page and removes the logo file', bandAfter === null && logoGone);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `BRANDING E2E FAILED (${failed} of ${results.length})` : `BRANDING E2E PASSED (${results.length} checks)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`BRANDING E2E could not finish: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
