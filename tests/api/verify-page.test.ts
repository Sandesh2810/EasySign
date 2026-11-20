// AT3.2 against the RUNNING app: the public /verify page.
// Run: start the app, then  npm run test:api
// Leaves one small cancelled test document behind per run (sent documents cannot be deleted, by design).
// Each run uses its own made-up caller address (X-Forwarded-For) so it never uses up anyone else's lookups.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { deriveToken, hashToken, newNonce } from '@/lib/signer-token';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const TOKEN_KEY = process.env.SIGNER_TOKEN_KEY!;
const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SENDER_EMAIL = 'e2e-verify-sender@example.test';
const SIGNER_NAME = 'Vivian Verifytest';
const TITLE = `Verify page ${randomBytes(3).toString('hex')}`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const caller = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomBytes(4).toString('hex')}`;

let db: SupabaseClient;
let senderId = '';
let envelopeId = '';
let code = '';

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
async function page(q: string, ip = caller()) {
  const res = await fetch(`${APP}/verify${q}`, { headers: { 'X-Forwarded-For': ip } });
  return { status: res.status, headers: res.headers, html: await res.text() };
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SECRET || !TOKEN_KEY) throw new Error('Settings are missing. Run "npm run setup:env".');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first (npm run dev, or double-click Start-YouNMeSign.cmd), then run this again.`);
  db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

  const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  senderId = list.data?.users.find((u) => u.email === SENDER_EMAIL)?.id ?? '';
  if (!senderId) {
    const created = await db.auth.admin.createUser({ email: SENDER_EMAIL, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: 'Verify Test Sender' } });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    senderId = created.data.user.id;
  }
  await db.from('account_controls').update({ approved: true, daily_envelope_cap: 100000, daily_recipient_cap: 100000 }).eq('user_id', senderId);
  const orgId = (await db.from('memberships').select('org_id').eq('user_id', senderId).eq('role', 'owner').single()).data!.org_id as string;

  const env = await rpc<{ id: string; public_code: string }>('create_envelope', { p_actor: senderId, p_org_id: orgId, p_title: TITLE, p_folder_id: null });
  envelopeId = env.id;
  code = env.public_code;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText(`Verify ${randomUUID()}`);
  const bytes = await pdf.save();
  const path = `${orgId}/${envelopeId}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc<{ id: string }>('add_envelope_document', {
    p_actor: senderId, p_envelope_id: envelopeId, p_filename: 'doc1.pdf', p_storage_backend: 'supabase', p_storage_path: path,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf',
  });
  const saved = await rpc<{ id: string }[]>('save_recipients', {
    p_actor: senderId, p_envelope_id: envelopeId, p_recipients: [{ name: SIGNER_NAME, email: `e2e-vivian-${randomBytes(3).toString('hex')}@example.test`, role: 'signer', routing_order: 1 }],
  });
  await rpc('save_fields', { p_actor: senderId, p_envelope_id: envelopeId, p_fields: [{ document_id: doc.id, recipient_id: saved[0].id, type: 'signature', page: 1, x: 0.1, y: 0.5, w: 0.4, h: 0.1 }] });
  const tokenId = randomUUID();
  const nonce = newNonce();
  const token = deriveToken(TOKEN_KEY, tokenId, nonce);
  await rpc('send_envelope', {
    p_actor: senderId, p_envelope_id: envelopeId,
    p_tokens: [{ recipient_id: saved[0].id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
    p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link',
  });
}, 120_000);

afterAll(async () => {
  if (envelopeId && senderId) await db.rpc('void_envelope', { p_actor: senderId, p_envelope_id: envelopeId, p_reason: 'verify-page test finished' });
});

describe('AT3.2 public /verify page, through the running app', () => {
  it('is never cached, leaks no addresses through referrers, and cannot be framed', async () => {
    const r = await page('?code=ES-2611-AAAA-BBBB-CCCC-DD');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.html).toMatch(/noindex/);
  });

  it('an unknown code, a malformed code and a wrong check digit all get the same "not found"', async () => {
    const wrongCheck = code.slice(0, -2) + (code.endsWith('00') ? '11' : '00');
    for (const q of ['ES-2611-AAAA-BBBB-CCCC-DD', 'hello', wrongCheck]) {
      const r = await page(`?code=${encodeURIComponent(q)}`);
      expect(r.html).toContain('No document found for this code');
      expect(r.html).not.toContain('Still being signed');
    }
  });

  it('a document still being signed shows only that, with no names, emails, title or hashes', async () => {
    const r = await page(`?code=${encodeURIComponent(code.toLowerCase())}`);
    expect(r.html).toContain('Still being signed');
    expect(r.html).not.toContain(SIGNER_NAME);
    expect(r.html).not.toContain(TITLE);
    expect(r.html).not.toContain('@example.test');
    expect(r.html).not.toContain('Check your copy');
    const hits = await db.from('audit_events').select('payload, ip, user_agent').eq('envelope_id', envelopeId).eq('event_type', 'verify_page_hit');
    expect(hits.data?.length).toBeGreaterThanOrEqual(1);
    expect(hits.data?.every((h) => h.ip === null && h.user_agent === null)).toBe(true);
  });

  it('a cancelled document says it was cancelled', async () => {
    await rpc('void_envelope', { p_actor: senderId, p_envelope_id: envelopeId, p_reason: 'verify-page test: cancel' });
    const r = await page(`?code=${encodeURIComponent(code)}`);
    expect(r.html).toContain('Cancelled');
    expect(r.html).not.toContain('Verify Test Sender');
  });

  it('after 20 lookups in 10 minutes the same caller is told to wait; another caller is not', async () => {
    const ip = caller();
    // A fresh unknown code each run: each code also has its own limit (60 lookups an hour), and this test makes 22,
    // so a fixed code made the third run within an hour fail for the wrong reason.
    const code = `ES-2611-ZZZZ-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}-ZZ`;
    let limitedAt = 0;
    for (let i = 1; i <= 21; i++) {
      const r = await page(`?code=${code}`, ip);
      if (r.html.includes('Too many checks')) { limitedAt = i; break; }
    }
    expect(limitedAt).toBe(21);
    expect((await page(`?code=${code}`)).html).toContain('No document found');
  }, 120_000);
});
