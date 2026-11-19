// AT2.10 against the RUNNING app: "Report this document" flags it; an administrator suspends the sender;
// the open document goes on hold (link opens nothing, a warning is shown, no file); lifting the suspension
// lets the same link work again.
// Run: start the app, then  npm run test:api
// Leaves one small voided test document behind per run (sent documents cannot be deleted, by design).
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
const SENDER_EMAIL = 'e2e-abuse-sender@example.test';
const ADMIN_EMAIL = 'e2e-abuse-admin@example.test';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

let db: SupabaseClient;
let senderId = '';
let adminId = '';
let envelopeId = '';
let token = '';
let fileSha = '';

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
async function ensureUser(email: string, name: string): Promise<string> {
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = list.data?.users.find((u) => u.email === email);
  if (found) return found.id;
  const created = await db.auth.admin.createUser({ email, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: name } });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  return created.data.user.id;
}
async function open(t: string) {
  const res = await fetch(`${APP}/api/sign/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP }, body: JSON.stringify({ token: t }) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], error: data.error ?? '' };
}
async function report(body: Record<string, unknown>, cookie = '') {
  const res = await fetch(`${APP}/api/sign/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string };
  return { status: res.status, ...data };
}
async function file(cookie: string) {
  const res = await fetch(`${APP}/api/sign/document`, { headers: { Cookie: cookie } });
  return { status: res.status, sha: res.ok ? sha(new Uint8Array(await res.arrayBuffer())) : '' };
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SECRET || !TOKEN_KEY) throw new Error('Settings are missing. Run "npm run setup:env" (or double-click Enter-Supabase-Key.cmd).');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first (npm run dev, or double-click Start-YouNMeSign.cmd), then run this again.`);
  db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  await db.from('rate_limits').delete().in('bucket', ['sign_open_ip', 'sign_report_ip']);

  senderId = await ensureUser(SENDER_EMAIL, 'Abuse Test Sender');
  adminId = await ensureUser(ADMIN_EMAIL, 'Abuse Test Admin');
  await db.from('account_controls').update({ approved: true, trust_level: 'restricted', suspended_at: null, suspended_reason: null, trust_before_suspension: null, daily_envelope_cap: 100000, daily_recipient_cap: 100000 }).eq('user_id', senderId);
  await db.from('account_controls').update({ approved: true, is_platform_admin: true, trust_level: 'trusted' }).eq('user_id', adminId);
  const orgId = (await db.from('memberships').select('org_id').eq('user_id', senderId).eq('role', 'owner').single()).data!.org_id as string;

  envelopeId = (await rpc<{ id: string }>('create_envelope', { p_actor: senderId, p_org_id: orgId, p_title: `Abuse flow ${randomBytes(3).toString('hex')}`, p_folder_id: null })).id;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText(`Abuse flow ${randomUUID()}`);
  const bytes = await pdf.save();
  fileSha = sha(bytes);
  const path = `${orgId}/${envelopeId}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc<{ id: string }>('add_envelope_document', {
    p_actor: senderId, p_envelope_id: envelopeId, p_filename: 'doc1.pdf', p_storage_backend: 'supabase', p_storage_path: path,
    p_sha256: fileSha, p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf',
  });
  const saved = await rpc<{ id: string }[]>('save_recipients', {
    p_actor: senderId, p_envelope_id: envelopeId, p_recipients: [{ name: 'Wary Reader', email: `e2e-wary-${randomBytes(3).toString('hex')}@example.test`, role: 'signer', routing_order: 1 }],
  });
  await rpc('save_fields', { p_actor: senderId, p_envelope_id: envelopeId, p_fields: [{ document_id: doc.id, recipient_id: saved[0].id, type: 'signature', page: 1, x: 0.1, y: 0.5, w: 0.4, h: 0.1 }] });
  const tokenId = randomUUID();
  const nonce = newNonce();
  token = deriveToken(TOKEN_KEY, tokenId, nonce);
  await rpc('send_envelope', {
    p_actor: senderId, p_envelope_id: envelopeId,
    p_tokens: [{ recipient_id: saved[0].id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') }],
    p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link',
  });
}, 120_000);

afterAll(async () => {
  // never leave the shared test sender suspended, whatever happened above
  if (senderId && adminId) await db.rpc('admin_set_suspension', { p_actor: adminId, p_user: senderId, p_suspended: false, p_reason: null });
  if (envelopeId && senderId) await db.rpc('void_envelope', { p_actor: senderId, p_envelope_id: envelopeId, p_reason: 'abuse-flow test finished' });
  // the synthetic administrator is one only while this test runs
  if (adminId) await db.from('account_controls').update({ is_platform_admin: false }).eq('user_id', adminId);
});

describe('AT2.10 abuse flow, through the running app', () => {
  it('"Report this document" flags it for the administrators, once, without signing anything', async () => {
    expect((await report({ reason: 'x', token })).status).toBe(400); // too short to be a reason
    expect((await report({ reason: 'I do not know this sender at all' })).status).toBe(401); // no session and no link
    const first = await report({ reason: 'I do not know this sender at all', token });
    expect(first).toMatchObject({ status: 200, ok: true, already: false });
    const second = await report({ reason: 'still odd', token });
    expect(second).toMatchObject({ status: 200, already: true });
    const reports = await rpc<{ envelope_id: string; report_status: string; reason: string }[]>('admin_list_abuse_reports', { p_actor: adminId });
    const mine = reports.filter((r) => r.envelope_id === envelopeId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ report_status: 'open', reason: 'I do not know this sender at all' });
    expect((await db.from('recipients').select('status').eq('envelope_id', envelopeId).single()).data?.status).toBe('sent');
  });

  it('while the sender is suspended the link opens nothing, shows the warning and gives no file; lifting it restores everything', async () => {
    const before = await open(token);
    expect(before.status).toBe(200);
    const oldCookie = before.cookie;
    expect((await file(oldCookie)).sha).toBe(fileSha);

    expect(await rpc<string>('admin_set_suspension', { p_actor: adminId, p_user: senderId, p_suspended: true, p_reason: 'abuse-flow test' })).toBe('suspended');
    const held = await open(token);
    expect(held.status).toBe(423);
    expect(held.cookie).toBe('');
    expect(held.error).toContain('on hold');
    expect(held.error).toContain('Do not send money or personal details');
    // a session opened before the suspension is closed too
    expect((await file(oldCookie)).status).toBe(423);
    const page = await (await fetch(`${APP}/sign`, { headers: { Cookie: oldCookie } })).text();
    expect(page).toContain('This document is on hold');
    // reporting still works while on hold
    expect((await report({ reason: 'second person, same worry', token })).already).toBe(true);

    expect(await rpc<string>('admin_set_suspension', { p_actor: adminId, p_user: senderId, p_suspended: false, p_reason: null })).toBe('lifted');
    const after = await open(token);
    expect(after.status).toBe(200);
    expect((await file(after.cookie)).sha).toBe(fileSha);
  }, 60_000);
});
