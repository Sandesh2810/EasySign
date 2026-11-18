// End-to-end checks of the signer-facing routes against the RUNNING app (AT2.1 "out-of-turn gets 403 +
// audit event", carried Phase 1 item "API-level tests for the signer routes").
// Run: start the app (npm run dev, or Start-EasySign.cmd), then  npm run test:api
// It prepares one document for a fixed synthetic sender through the same server-only database functions
// the app uses, then talks to the app over HTTP exactly as a signer's browser would.
// Nothing is emailed (links are "shared by the sender"). Each run leaves one small declined test document
// behind: sent documents cannot be deleted, by design.
import { describe, it, expect, beforeAll } from 'vitest';
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
const SENDER_EMAIL = 'e2e-sender@example.test';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

let db: SupabaseClient;
let envelopeId: string;
let originalSha: string;
const people: Record<'boss' | 'one' | 'two', { id: string; tokenId: string; token: string }> = {} as never;
const cookies: Record<string, string> = {};

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

/** POST the link token the way the /s page does. */
async function open(token: string, origin: string | null = APP) {
  const res = await fetch(`${APP}/api/sign/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ token }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { status: res.status, body, setCookie, cookie: setCookie.split(';')[0] };
}
const get = (path: string, cookie?: string) => fetch(`${APP}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
const auditCount = async (type: string, recipientId?: string) => {
  let q = db.from('audit_events').select('seq', { count: 'exact', head: true }).eq('envelope_id', envelopeId).eq('event_type', type);
  if (recipientId) q = q.eq('recipient_id', recipientId);
  return (await q).count ?? 0;
};

beforeAll(async () => {
  if (!SUPABASE_URL || !SECRET || !TOKEN_KEY) throw new Error('Settings are missing. Run "npm run setup:env" (or double-click Enter-Supabase-Key.cmd).');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first (npm run dev, or double-click Start-EasySign.cmd), then run this again.`);
  db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

  // a fixed synthetic sender, reused by every run; its password is random and never used
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  let sender = list.data?.users.find((u) => u.email === SENDER_EMAIL);
  if (!sender) {
    const created = await db.auth.admin.createUser({ email: SENDER_EMAIL, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: 'E2E Sender' } });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    sender = created.data.user;
  }
  const controls = await db.from('account_controls').update({ approved: true, daily_envelope_cap: 100000, daily_recipient_cap: 100000 }).eq('user_id', sender.id);
  if (controls.error) throw new Error(`account_controls: ${controls.error.message}`);
  const membership = await db.from('memberships').select('org_id').eq('user_id', sender.id).eq('role', 'owner').single();
  if (membership.error) throw new Error(`membership: ${membership.error.message}`);
  const orgId = membership.data.org_id as string;

  const env = await rpc<{ id: string }>('create_envelope', { p_actor: sender.id, p_org_id: orgId, p_title: 'Signer routes test', p_folder_id: null });
  envelopeId = env.id;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText(`Signer routes test ${randomUUID()}`);
  const bytes = await pdf.save();
  originalSha = sha(bytes);
  const path = `${orgId}/${envelopeId}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc<{ id: string }>('add_envelope_document', {
    p_actor: sender.id, p_envelope_id: envelopeId, p_filename: 'doc1.pdf', p_storage_backend: 'supabase', p_storage_path: path,
    p_sha256: originalSha, p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf',
  });

  const saved = await rpc<{ id: string; email: string }[]>('save_recipients', {
    p_actor: sender.id,
    p_envelope_id: envelopeId,
    p_recipients: [
      { name: 'Boss Approver', email: 'e2e-boss@example.test', role: 'approver', routing_order: 1 },
      { name: 'One Signer', email: 'e2e-one@example.test', role: 'signer', routing_order: 2 },
      { name: 'Two Signer', email: 'e2e-two@example.test', role: 'signer', routing_order: 3 },
      { name: 'Copy Only', email: 'e2e-copy@example.test', role: 'cc', routing_order: 3 },
    ],
  });
  const idOf = (email: string) => saved.find((r) => r.email === email)!.id;
  const field = (recipientId: string, y: number) => ({ document_id: doc.id, recipient_id: recipientId, type: 'signature', page: 1, x: 0.1, y, w: 0.4, h: 0.1 });
  await rpc('save_fields', { p_actor: sender.id, p_envelope_id: envelopeId, p_fields: [field(idOf('e2e-one@example.test'), 0.5), field(idOf('e2e-two@example.test'), 0.7)] });

  const tokens = (['boss', 'one', 'two'] as const).map((who) => {
    const id = idOf({ boss: 'e2e-boss@example.test', one: 'e2e-one@example.test', two: 'e2e-two@example.test' }[who]);
    const tokenId = randomUUID();
    const nonce = newNonce();
    const token = deriveToken(TOKEN_KEY, tokenId, nonce);
    people[who] = { id, tokenId, token };
    return { recipient_id: id, token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') };
  });
  await rpc('send_envelope', { p_actor: sender.id, p_envelope_id: envelopeId, p_tokens: tokens, p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link' });
}, 90_000);

describe('signer routes of the running app', () => {
  it('sharing links by hand queued no email at all', async () => {
    const { count } = await db.from('notification_outbox').select('id', { count: 'exact', head: true }).eq('envelope_id', envelopeId);
    expect(count).toBe(0);
  });

  it('refuses a request that does not come from the app itself, and an unknown link', async () => {
    expect((await open(people.boss.token, null)).status).toBe(403);
    expect((await open(people.boss.token, 'https://evil.example')).status).toBe(403);
    const unknown = await open(randomBytes(32).toString('base64url'));
    expect(unknown.status).toBe(404);
    expect(unknown.setCookie).toBe('');
  });

  it('AT2.1: a valid link used before its turn gets 403, no session, and an audit event', async () => {
    const before = await auditCount('out_of_turn', people.one.id);
    const res = await open(people.one.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your turn/i);
    expect(res.setCookie).toBe('');
    expect(await auditCount('out_of_turn', people.one.id)).toBe(before + 1);
    const { data } = await db.from('recipients').select('status').eq('id', people.one.id).single();
    expect(data?.status).toBe('created');
  });

  it('the person whose turn it is gets a session cookie that scripts cannot read', async () => {
    const res = await open(people.boss.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.setCookie).toMatch(/^es_signer=/);
    expect(res.setCookie).toMatch(/HttpOnly/i);
    expect(res.setCookie).toMatch(/SameSite=lax/i);
    expect(res.setCookie).not.toContain(people.boss.token);
    cookies.boss = res.cookie;
  });

  it('the signing page and the document are served only with that session', async () => {
    const page = await get('/sign', cookies.boss);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Signer routes test');

    const file = await get('/api/sign/document', cookies.boss);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(sha(new Uint8Array(await file.arrayBuffer()))).toBe(originalSha);

    expect((await get('/api/sign/document')).status).toBe(401);
    expect((await get('/api/sign/document', `${cookies.boss}x`)).status).toBe(401);
    expect((await get('/api/sign/document', 'es_signer=abc.def')).status).toBe(401);
    expect((await get('/api/sign/document?part=sealed', cookies.boss)).status).toBe(404);
    expect((await get('/api/sign/document?part=signature', cookies.boss)).status).toBe(404);
  });

  it('after the approver approves, the next person gets in and the one after still does not', async () => {
    await rpc('signer_consent', { p_token_id: people.boss.tokenId, p_version: 'test', p_disclosure_sha256: sha('test'), p_ip: null, p_user_agent: 'api-test' });
    expect(await rpc<string>('signer_approve', { p_token_id: people.boss.tokenId, p_ip: null, p_user_agent: 'api-test' })).toBe('waiting');
    const one = await open(people.one.token);
    expect(one.status).toBe(200);
    cookies.one = one.cookie;
    expect((await open(people.two.token)).status).toBe(403);
  });

  it('a decline closes every door at once: old sessions stop working and the remaining links open nothing', async () => {
    await rpc('signer_decline', { p_token_id: people.one.tokenId, p_reason: 'api test', p_ip: null, p_user_agent: 'api-test' });
    const { data } = await db.from('envelopes').select('status').eq('id', envelopeId).single();
    expect(data?.status).toBe('declined');
    expect((await get('/api/sign/document', cookies.one)).status).toBe(401);
    expect((await get('/api/sign/document', cookies.boss)).status).toBe(401);
    expect((await open(people.two.token)).status).toBe(404);
    expect((await open(people.one.token)).status).toBe(404);
    const page = await get('/sign', cookies.one);
    expect(await page.text()).toContain('session has ended');
  });

  it('the whole episode is in an audit chain that verifies', async () => {
    const { data, error } = await db.from('audit_events').select('chain_seq, event_type').eq('envelope_id', envelopeId).order('chain_seq');
    expect(error).toBeNull();
    const types = (data ?? []).map((e) => e.event_type);
    expect((data ?? []).map((e) => e.chain_seq)).toEqual((data ?? []).map((_, i) => i + 1));
    for (const t of ['envelope_sent', 'recipient_activated', 'out_of_turn', 'link_opened', 'consent_given', 'recipient_approved', 'recipient_declined', 'envelope_declined', 'token_failed']) expect(types).toContain(t);
    expect(types).not.toContain('email_queued');
  });
});
