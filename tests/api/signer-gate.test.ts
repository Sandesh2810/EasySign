// AT2.7 against the RUNNING app: the extra identity checks (access code, emailed code).
//   - a link alone opens nothing when the sender asked for a check
//   - wrong codes are counted; five lock the link; even the right code is refused while locked
//   - codes are hashed at rest
//   - a verified session is bound to one link: it cannot be reused on another document
// Run: start the app (and, for the emailed code, the worker), then  npm run test:api
// Leaves two small voided test documents behind per run (sent documents cannot be deleted, by design).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { hashAccessCode } from '@/lib/access-code';
import { deriveToken, hashOtp, hashToken, newNonce } from '@/lib/signer-token';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const TOKEN_KEY = process.env.SIGNER_TOKEN_KEY!;
const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SENDER_EMAIL = 'e2e-sender@example.test';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const tag = randomBytes(3).toString('hex');
const CODE_A = `heron-${randomBytes(4).toString('hex')}`;
const CODE_B = `otter-${randomBytes(4).toString('hex')}`;

let db: SupabaseClient;
let senderId: string;
let orgId: string;
interface Person { id: string; tokenId: string; token: string; email: string }
const docA = { id: '', title: `Gate A ${tag}`, fileSha: '', code: {} as Person, mail: {} as Person };
const docB = { id: '', title: `Gate B ${tag}`, fileSha: '', code: {} as Person };

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
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
async function open(token: string, cookie = '') {
  const res = await fetch(`${APP}/api/sign/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ token }) });
  return { status: res.status, cookie: cookieOf(res) };
}
async function gate(cookie: string, payload: Record<string, unknown>, origin: string | null = APP) {
  const res = await fetch(`${APP}/api/sign/gate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(payload) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; already?: boolean };
  return { status: res.status, cookie: cookieOf(res), error: data.error ?? '', already: data.already === true };
}
async function file(cookie: string) {
  const res = await fetch(`${APP}/api/sign/document`, { headers: { Cookie: cookie } });
  return { status: res.status, sha: res.ok ? sha(new Uint8Array(await res.arrayBuffer())) : '' };
}
const page = async (cookie: string) => (await fetch(`${APP}/sign`, { headers: { Cookie: cookie } })).text();
const events = async (envelopeId: string, recipientId: string, type: string) =>
  (await db.from('audit_events').select('id', { count: 'exact', head: true }).eq('envelope_id', envelopeId).eq('recipient_id', recipientId).eq('event_type', type)).count ?? 0;

async function makeDocument(title: string, people: { name: string; email: string; check: 'access_code' | 'email_otp'; code?: string }[]) {
  const envelopeId = (await rpc<{ id: string }>('create_envelope', { p_actor: senderId, p_org_id: orgId, p_title: title, p_folder_id: null })).id;
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText(`${title} ${randomUUID()}`);
  const bytes = await pdf.save();
  const path = `${orgId}/${envelopeId}/doc1.pdf`;
  const up = await db.storage.from('originals').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const doc = await rpc<{ id: string }>('add_envelope_document', {
    p_actor: senderId, p_envelope_id: envelopeId, p_filename: 'doc1.pdf', p_storage_backend: 'supabase', p_storage_path: path,
    p_sha256: sha(bytes), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf',
  });
  const saved = await rpc<{ id: string; email: string }[]>('save_recipients', {
    p_actor: senderId, p_envelope_id: envelopeId, p_recipients: people.map((p) => ({ name: p.name, email: p.email, role: 'signer', routing_order: 1 })),
  });
  await rpc('save_fields', {
    p_actor: senderId, p_envelope_id: envelopeId,
    p_fields: saved.map((r, i) => ({ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.3 + i * 0.2, w: 0.4, h: 0.1 })),
  });
  await rpc('set_routing_mode', { p_actor: senderId, p_envelope_id: envelopeId, p_mode: 'parallel' });
  const out: Person[] = [];
  const tokens = [];
  for (const p of people) {
    const row = saved.find((r) => r.email === p.email)!;
    await rpc('set_recipient_auth', {
      p_actor: senderId, p_envelope_id: envelopeId, p_recipient_id: row.id, p_method: p.check,
      p_access_code_hash: p.check === 'access_code' ? await hashAccessCode(p.code!) : null,
    });
    const t = mint();
    tokens.push({ recipient_id: row.id, ...t.record });
    out.push({ id: row.id, tokenId: t.tokenId, token: t.token, email: p.email });
  }
  await rpc('send_envelope', { p_actor: senderId, p_envelope_id: envelopeId, p_tokens: tokens, p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), p_delivery: 'link' });
  return { envelopeId, fileSha: sha(bytes), people: out };
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SECRET || !TOKEN_KEY) throw new Error('Settings are missing. Run "npm run setup:env" (or double-click Enter-Supabase-Key.cmd).');
  const alive = await fetch(`${APP}/login`).then((r) => r.ok).catch(() => false);
  if (!alive) throw new Error(`The app is not running at ${APP}. Start it first (npm run dev, or double-click Start-YouNMeSign.cmd), then run this again.`);
  db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  // These tests make many requests from one address on purpose; start from a clean per-address counter so
  // that running them several times in a row does not trip the app's own request limiter (development database only).
  await db.from('rate_limits').delete().in('bucket', ['sign_gate_ip', 'sign_open_ip']);
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  let sender = list.data?.users.find((u) => u.email === SENDER_EMAIL);
  if (!sender) {
    const created = await db.auth.admin.createUser({ email: SENDER_EMAIL, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: 'E2E Sender' } });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    sender = created.data.user;
  }
  senderId = sender.id;
  await db.from('account_controls').update({ approved: true, daily_envelope_cap: 100000, daily_recipient_cap: 100000 }).eq('user_id', senderId);
  orgId = (await db.from('memberships').select('org_id').eq('user_id', senderId).eq('role', 'owner').single()).data!.org_id as string;

  const a = await makeDocument(docA.title, [
    { name: 'Gate Code', email: `e2e-gate-code-${tag}@example.test`, check: 'access_code', code: CODE_A },
    { name: 'Gate Mail', email: `e2e-gate-mail-${tag}@example.test`, check: 'email_otp' },
  ]);
  Object.assign(docA, { id: a.envelopeId, fileSha: a.fileSha, code: a.people[0], mail: a.people[1] });
  const b = await makeDocument(docB.title, [{ name: 'Other Code', email: `e2e-gate-other-${tag}@example.test`, check: 'access_code', code: CODE_B }]);
  Object.assign(docB, { id: b.envelopeId, fileSha: b.fileSha, code: b.people[0] });
}, 120_000);

afterAll(async () => {
  for (const id of [docA.id, docB.id]) if (id) await db.rpc('void_envelope', { p_actor: senderId, p_envelope_id: id, p_reason: 'identity-check test finished' });
});

describe('AT2.7 identity checks, through the running app', () => {
  let linkOnly = '';
  let verifiedA = '';

  it('codes are hashed at rest: no access code or emailed code is readable in the database', async () => {
    const { data } = await db.from('recipients').select('auth_method, access_code_hash').in('id', [docA.code.id, docA.mail.id, docB.code.id]);
    const hashes = (data ?? []).map((r) => r.access_code_hash as string | null);
    expect(hashes.filter(Boolean)).toHaveLength(2);
    for (const h of hashes.filter(Boolean)) {
      expect(h).toMatch(/^scrypt\$32768\$8\$3\$/);
      expect(h).not.toContain(CODE_A);
      expect(h).not.toContain(CODE_B);
    }
    const audit = await db.from('audit_events').select('*').in('envelope_id', [docA.id, docB.id]);
    expect(JSON.stringify(audit.data)).not.toContain(CODE_A);
    expect(JSON.stringify(audit.data)).not.toContain('scrypt$');
  });

  it('the link alone opens nothing: no file, no title, only the code screen', async () => {
    const o = await open(docA.code.token);
    expect(o.status).toBe(200);
    linkOnly = o.cookie;
    expect((await file(linkOnly)).status).toBe(401);
    const html = await page(linkOnly);
    expect(html).toContain('One more step before your document opens');
    expect(html).not.toContain(docA.title);
    // the signer functions behind the document are closed too (the app refuses before calling them)
    expect((await gate(linkOnly, { action: 'email_code', code: '123456' })).status).toBe(400); // wrong kind of check for this person
    expect((await gate(linkOnly, { action: 'access_code', code: CODE_A }, null)).status).toBe(403); // not from our own page
    expect((await gate('', { action: 'access_code', code: CODE_A })).status).toBe(401); // no session at all
  });

  it('a wrong access code is refused, counted and written to the audit trail; the right one opens the document', async () => {
    const wrong = await gate(linkOnly, { action: 'access_code', code: 'not-the-code' });
    expect(wrong.status).toBe(403);
    expect(wrong.error).toContain('4 tries left');
    expect(wrong.cookie).toBe('');
    expect(await events(docA.id, docA.code.id, 'check_failed')).toBe(1);
    expect((await file(linkOnly)).status).toBe(401);

    const right = await gate(linkOnly, { action: 'access_code', code: CODE_A });
    expect(right.status).toBe(200);
    expect(right.cookie).not.toBe('');
    verifiedA = right.cookie;
    const got = await file(verifiedA);
    expect(got.status).toBe(200);
    expect(got.sha).toBe(docA.fileSha);
    expect(await page(verifiedA)).toContain(docA.title);
    expect(await events(docA.id, docA.code.id, 'check_passed')).toBe(1);
    // the earlier, unverified cookie was not upgraded behind the browser's back
    expect((await file(linkOnly)).status).toBe(401);
    // asking again with a verified session changes nothing
    expect((await gate(verifiedA, { action: 'access_code', code: 'anything' })).already).toBe(true);
    expect(await events(docA.id, docA.code.id, 'check_failed')).toBe(1);
  });

  it('no session reuse across documents: a verified session for document A opens nothing of document B', async () => {
    // the same browser (still holding A's verified cookie) opens B's link
    const o = await open(docB.code.token, verifiedA);
    expect(o.status).toBe(200);
    expect(o.cookie).not.toBe(verifiedA);
    const sessionB = o.cookie;
    expect((await file(sessionB)).status).toBe(401); // B still needs its own code
    expect(await page(sessionB)).not.toContain(docB.title);
    // A's verified cookie keeps showing A, never B
    const viaA = await file(verifiedA);
    expect(viaA.sha).toBe(docA.fileSha);
    expect(viaA.sha).not.toBe(docB.fileSha);
    // A's code does not open B
    const cross = await gate(sessionB, { action: 'access_code', code: CODE_A });
    expect(cross.status).toBe(403);
    expect((await file(sessionB)).status).toBe(401);
    const passedB = (await db.from('recipient_auth').select('last_passed_at, failed_attempts').eq('recipient_id', docB.code.id).maybeSingle()).data;
    expect(passedB?.last_passed_at ?? null).toBeNull();
    expect(passedB?.failed_attempts).toBe(1);
  });

  it('five wrong codes lock the link; the right code is refused while locked; the sender is told and can unlock', async () => {
    const o = await open(docB.code.token);
    const session = o.cookie;
    let last = { status: 0, error: '' };
    for (let i = 0; i < 4; i++) last = await gate(session, { action: 'access_code', code: `guess-${i}-xyz` }); // tries 2..5 (one was used above)
    expect(last.status).toBe(423);
    expect(last.error).toContain('locked for 15 minutes');
    const refused = await gate(session, { action: 'access_code', code: CODE_B });
    expect(refused.status).toBe(423);
    expect((await file(session)).status).toBe(401);
    expect(await events(docB.id, docB.code.id, 'check_failed')).toBe(5);
    expect(await events(docB.id, docB.code.id, 'link_locked')).toBe(1);
    const notice = await db.from('notifications').select('payload').eq('user_id', senderId).eq('kind', 'signer_locked').eq('payload->>envelope_id', docB.id);
    expect(notice.data).toHaveLength(1);

    expect(await rpc<boolean>('unlock_recipient_auth', { p_actor: senderId, p_envelope_id: docB.id, p_recipient_id: docB.code.id })).toBe(true);
    const after = await gate(session, { action: 'access_code', code: CODE_B });
    expect(after.status).toBe(200);
    expect((await file(after.cookie)).sha).toBe(docB.fileSha);
  }, 60_000);

  it('emailed code: nothing readable is stored, a wrong code is refused, the right one works once', async () => {
    const o = await open(docA.mail.token);
    const session = o.cookie;
    expect((await file(session)).status).toBe(401);
    expect((await gate(session, { action: 'email_code', code: '000000' })).status).toBe(410); // no code has been asked for yet
    const asked = await gate(session, { action: 'request_code' });
    expect(asked.status).toBe(200);
    expect((await gate(session, { action: 'request_code' })).status).toBe(429); // not twice within a minute

    const row = (await db.from('notification_outbox').select('id, payload, priority, status').eq('recipient_id', docA.mail.id).eq('kind', 'otp').single()).data!;
    expect(row.priority).toBe('P0_REQUEST'); // since migration 19 (D-63): counts against the sender's own limits
    expect(row.payload).toEqual({});

    // Either this test plays the worker for that one email, or the running worker already took it.
    let code = '';
    const taken = await db.from('notification_outbox').update({ status: 'sending', attempts: 1, locked_until: new Date(Date.now() + 60_000).toISOString() }).eq('id', row.id).eq('status', 'queued').select('id');
    if ((taken.data ?? []).length === 1) {
      code = '482913';
      const stored = await rpc<boolean>('signer_store_otp', { p_outbox_id: row.id, p_otp_hash: `\\x${hashOtp(code, docA.mail.id, TOKEN_KEY).toString('hex')}` });
      expect(stored).toBe(true);
      await rpc('finish_outbox', { p_id: row.id, p_outcome: 'sent', p_not_before: null, p_provider_message_id: 'api-test', p_error: null });
    } else {
      // the worker sent it: in log mode the email is a file in .dev-outbox
      for (let i = 0; i < 40 && !code; i++) {
        const name = existsSync('.dev-outbox') ? readdirSync('.dev-outbox').find((n) => n.includes(`_otp_${docA.mail.email}_`) && n.endsWith('.html')) : undefined;
        const m = name ? readFileSync(`.dev-outbox/${name}`, 'utf8').match(/>(\d{3}) (\d{3})</) : null;
        if (m) code = m[1] + m[2];
        else await new Promise((r) => setTimeout(r, 500));
      }
      expect(code, 'the worker took the code email but no file with a code appeared in .dev-outbox').toMatch(/^\d{6}$/);
    }

    const state = (await db.from('recipient_auth').select('otp_hash, otp_expires_at').eq('recipient_id', docA.mail.id).single()).data!;
    expect(String(state.otp_hash)).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(String(state.otp_hash)).not.toContain(code);
    expect(new Date(state.otp_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 8 * 60_000);
    expect(new Date(state.otp_expires_at as string).getTime()).toBeLessThan(Date.now() + 11 * 60_000);

    const wrongCode = code === '111111' ? '222222' : '111111';
    const wrong = await gate(session, { action: 'email_code', code: wrongCode });
    expect(wrong.status).toBe(403);
    expect(wrong.error).toContain('4 tries left');
    const right = await gate(session, { action: 'email_code', code: `${code.slice(0, 3)} ${code.slice(3)}` }); // typed with the space shown in the email
    expect(right.status).toBe(200);
    expect((await file(right.cookie)).sha).toBe(docA.fileSha);

    // single use: a fresh, unverified session cannot use the same code again
    const again = await open(docA.mail.token);
    expect((await gate(again.cookie, { action: 'email_code', code })).status).toBe(410);
    expect((await file(again.cookie)).status).toBe(401);
    const audit = await db.from('audit_events').select('*').eq('envelope_id', docA.id);
    expect(JSON.stringify(audit.data)).not.toContain(code);
  }, 60_000);
});
