// AT2.2 and AT2.3 against the RUNNING app: after a correction the old link is dead and the new one works;
// after a void every link and every existing signer session stops working at once.
// Run: start the app, then  npm run test:api
// Leaves one small voided test document behind per run (sent documents cannot be deleted, by design).
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { deriveToken, hashToken, newNonce } from '@/lib/signer-token';
import { CONSENT_TEXT, CONSENT_VERSION } from '@/config/legal';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const TOKEN_KEY = process.env.SIGNER_TOKEN_KEY!;
const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SENDER_EMAIL = 'e2e-sender@example.test';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

let db: SupabaseClient;
let senderId: string;
let envelopeId: string;
const one = { id: '', tokenId: '', token: '', cookie: '' };
const two = { id: '', tokenId: '', token: '', newToken: '', cookie: '' };

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
function mint() {
  const tokenId = randomUUID();
  const nonce = newNonce();
  const token = deriveToken(TOKEN_KEY, tokenId, nonce);
  return { tokenId, token, record: { token_id: tokenId, nonce: nonce.toString('hex'), token_sha256: hashToken(token).toString('hex') } };
}
async function open(token: string) {
  const res = await fetch(`${APP}/api/sign/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP }, body: JSON.stringify({ token }) });
  return { status: res.status, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}
const fileStatus = async (cookie: string) => (await fetch(`${APP}/api/sign/document`, { headers: { Cookie: cookie } })).status;
const statusOf = async (id: string) => (await db.from('recipients').select('status, email').eq('id', id).single()).data;

beforeAll(async () => {
  // slice 3: a consent must name a wording on file
  await createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } }).rpc('register_consent_version', { p_version: CONSENT_VERSION, p_body: CONSENT_TEXT });
  if (!SUPABASE_URL || !SECRET || !TOKEN_KEY) throw new Error('Settings are missing. Run "npm run setup:env" (or double-click Enter-Supabase-Key.cmd).');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first (npm run dev, or double-click Start-YouNMeSign.cmd), then run this again.`);
  db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

  const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  let sender = list.data?.users.find((u) => u.email === SENDER_EMAIL);
  if (!sender) {
    const created = await db.auth.admin.createUser({ email: SENDER_EMAIL, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: 'E2E Sender' } });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    sender = created.data.user;
  }
  senderId = sender.id;
  await db.from('account_controls').update({ approved: true, daily_envelope_cap: 100000, daily_recipient_cap: 100000 }).eq('user_id', senderId);
  const orgId = (await db.from('memberships').select('org_id').eq('user_id', senderId).eq('role', 'owner').single()).data!.org_id as string;

  envelopeId = (await rpc<{ id: string }>('create_envelope', { p_actor: senderId, p_org_id: orgId, p_title: 'Void and correct test', p_folder_id: null })).id;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText(`Void and correct test ${randomUUID()}`);
  const bytes = await pdf.save();
  const path = `${orgId}/${envelopeId}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc<{ id: string }>('add_envelope_document', {
    p_actor: senderId, p_envelope_id: envelopeId, p_filename: 'doc1.pdf', p_storage_backend: 'supabase', p_storage_path: path,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf',
  });
  const tag = randomBytes(3).toString('hex');
  const saved = await rpc<{ id: string; email: string }[]>('save_recipients', {
    p_actor: senderId,
    p_envelope_id: envelopeId,
    p_recipients: [
      { name: 'First Signer', email: `e2e-first-${tag}@example.test`, role: 'signer', routing_order: 1 },
      { name: 'Second Signer', email: `e2e-second-${tag}@example.test`, role: 'signer', routing_order: 1 },
    ],
  });
  one.id = saved.find((r) => r.email.startsWith('e2e-first'))!.id;
  two.id = saved.find((r) => r.email.startsWith('e2e-second'))!.id;
  const field = (recipientId: string, y: number) => ({ document_id: doc.id, recipient_id: recipientId, type: 'signature', page: 1, x: 0.1, y, w: 0.4, h: 0.1 });
  await rpc('save_fields', { p_actor: senderId, p_envelope_id: envelopeId, p_fields: [field(one.id, 0.5), field(two.id, 0.7)] });
  await rpc('set_routing_mode', { p_actor: senderId, p_envelope_id: envelopeId, p_mode: 'parallel' });
  const t1 = mint();
  const t2 = mint();
  Object.assign(one, { tokenId: t1.tokenId, token: t1.token });
  Object.assign(two, { tokenId: t2.tokenId, token: t2.token });
  await rpc('send_envelope', {
    p_actor: senderId,
    p_envelope_id: envelopeId,
    p_tokens: [{ recipient_id: one.id, ...t1.record }, { recipient_id: two.id, ...t2.record }],
    p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    p_delivery: 'link',
  });
}, 90_000);

describe('correct and void, through the running app', () => {
  it('both people can open their links and each gets a session', async () => {
    const a = await open(one.token);
    const b = await open(two.token);
    expect([a.status, b.status]).toEqual([200, 200]);
    one.cookie = a.cookie;
    two.cookie = b.cookie;
    expect(await fileStatus(one.cookie)).toBe(200);
    expect(await fileStatus(two.cookie)).toBe(200);
  });

  it('AT2.3: after the second person\'s email is corrected, their old link and old session are dead and the new link works; the first person is untouched', async () => {
    await rpc('signer_consent', { p_token_id: two.tokenId, p_version: CONSENT_VERSION, p_disclosure_sha256: sha(CONSENT_TEXT), p_ip: null, p_user_agent: 'api-test' });
    const fresh = mint();
    two.newToken = fresh.token;
    const result = await rpc<string>('correct_recipient', {
      p_actor: senderId, p_envelope_id: envelopeId, p_recipient_id: two.id, p_name: 'Second Signer', p_email: `e2e-corrected-${randomBytes(3).toString('hex')}@example.test`, p_token: fresh.record,
    });
    expect(result).toBe('email_changed');
    expect((await statusOf(two.id))?.status).toBe('sent'); // the consent given by the old address does not carry over

    expect((await open(two.token)).status).toBe(404);
    expect(await fileStatus(two.cookie)).toBe(401);
    const reopened = await open(two.newToken);
    expect(reopened.status).toBe(200);
    two.cookie = reopened.cookie;
    expect(await fileStatus(two.cookie)).toBe(200);

    expect(await fileStatus(one.cookie)).toBe(200);
    expect((await open(one.token)).status).toBe(200);
    const audit = await db.from('audit_events').select('payload').eq('envelope_id', envelopeId).eq('event_type', 'recipient_corrected').single();
    expect(audit.data?.payload).toMatchObject({ email_changed: true, link_reissued: true, progress_reset: true });
    expect(JSON.stringify(audit.data?.payload)).not.toContain('@');
  });

  it('AT2.2: voiding closes every link and every open session at the same moment', async () => {
    await rpc('void_envelope', { p_actor: senderId, p_envelope_id: envelopeId, p_reason: 'api test' });
    expect((await db.from('envelopes').select('status').eq('id', envelopeId).single()).data?.status).toBe('voided');
    expect(await fileStatus(one.cookie)).toBe(401);
    expect(await fileStatus(two.cookie)).toBe(401);
    expect((await open(one.token)).status).toBe(404);
    expect((await open(two.newToken)).status).toBe(404);
    const tokens = await db.from('recipient_tokens').select('revoked_at').eq('envelope_id', envelopeId);
    expect((tokens.data ?? []).every((t) => t.revoked_at !== null)).toBe(true);
  });

  it('AT2.2: a voided document cannot be voided again, corrected, or signed', async () => {
    for (const call of [
      db.rpc('void_envelope', { p_actor: senderId, p_envelope_id: envelopeId, p_reason: null }),
      db.rpc('correct_recipient', { p_actor: senderId, p_envelope_id: envelopeId, p_recipient_id: one.id, p_name: 'X', p_email: 'x@example.test', p_token: mint().record }),
      db.rpc('resend_request', { p_actor: senderId, p_envelope_id: envelopeId, p_recipient_id: one.id }),
      db.rpc('signer_consent', { p_token_id: one.tokenId, p_version: CONSENT_VERSION, p_disclosure_sha256: sha(CONSENT_TEXT), p_ip: null, p_user_agent: 'api-test' }),
      db.from('envelopes').update({ status: 'sent' }).eq('id', envelopeId).select('id'),
    ]) {
      const { error } = await call;
      expect(error).not.toBeNull();
    }
    expect((await db.from('envelopes').select('status').eq('id', envelopeId).single()).data?.status).toBe('voided');
  });
});
