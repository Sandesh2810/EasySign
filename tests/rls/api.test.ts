// API-level security tests (AT1.1, AT1.9, AT1.10). Unlike supabase/tests/rls_phase1.sql, which switches
// roles inside the database, these go through the real public API exactly as a browser or an attacker
// would: two real accounts, real sign-ins, real storage uploads.
// Run: npm run test:rls   (needs SUPABASE_SECRET_KEY in .env.local; uses synthetic @example.test users
// that are deleted afterwards. Audit events written for them stay behind: audit rows cannot be deleted.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { verifyChain, type AuditRow } from '@/lib/audit-chain';
import { isValidPublicCode } from '@/lib/public-code';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;

const run = randomBytes(4).toString('hex');
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
  orgId: string;
  folderId: string;
}

let admin: SupabaseClient;
let anon: SupabaseClient;
let A: TestUser;
let B: TestUser;
let envA: { id: string; public_code: string };
let docPath: string;
let originalPdf: Uint8Array;

async function makeUser(label: string): Promise<TestUser> {
  const email = `rls-${label}-${run}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `RLS ${label.toUpperCase()}` } });
  if (created.error || !created.data.user) throw new Error(`createUser ${label}: ${created.error?.message}`);
  const client = createClient(URL_, PUBLISHABLE, noSession);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(`signIn ${label}: ${signedIn.error.message}`);
  const m = await client.from('memberships').select('org_id, role').single();
  if (m.error) throw new Error(`membership ${label}: ${m.error.message}`);
  const f = await client.from('folders').select('id').eq('org_id', m.data.org_id).limit(1).single();
  if (f.error) throw new Error(`folder ${label}: ${f.error.message}`);
  return { id: created.data.user.id, email, client, orgId: m.data.org_id, folderId: f.data.id };
}

beforeAll(async () => {
  if (!URL_ || !PUBLISHABLE || !SECRET) throw new Error('Supabase keys are missing. Run "npm run setup:env" (or double-click Enter-Supabase-Key.cmd).');
  admin = createClient(URL_, SECRET, noSession);
  anon = createClient(URL_, PUBLISHABLE, noSession);
  [A, B] = await Promise.all([makeUser('a'), makeUser('b')]);

  const env = await admin.rpc('create_envelope', { p_actor: A.id, p_org_id: A.orgId, p_title: `RLS test ${run}`, p_folder_id: A.folderId });
  if (env.error) throw new Error(`create_envelope: ${env.error.message}`);
  envA = env.data as { id: string; public_code: string };

  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText('RLS test document');
  originalPdf = await pdf.save();
  docPath = `${A.orgId}/${envA.id}/doc1.pdf`;
  const up = await admin.storage.from('originals').upload(docPath, originalPdf, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new Error(`first upload of an original failed (the immutability trigger must allow it): ${up.error.message}`);

  const doc = await admin
    .from('envelope_documents')
    .insert({ org_id: B.orgId /* spoofed on purpose */, envelope_id: envA.id, filename: 'doc1.pdf', storage_path: docPath, sha256: sha(originalPdf), page_count: 1, size_bytes: originalPdf.length, page_boxes: [] })
    .select('id, org_id')
    .single();
  if (doc.error) throw new Error(`document: ${doc.error.message}`);
  expect(doc.data.org_id).toBe(A.orgId); // guard corrected the tenant
  const rcp = await admin.from('recipients').insert({ org_id: A.orgId, envelope_id: envA.id, name: 'Sam Signer', email: 'sam@example.test', access_code_hash: 'not-a-real-hash' }).select('id').single();
  if (rcp.error) throw new Error(`recipient: ${rcp.error.message}`);
  const fld = await admin.from('fields').insert({ org_id: A.orgId, envelope_id: envA.id, document_id: doc.data.id, recipient_id: rcp.data.id, type: 'signature', page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.05 });
  if (fld.error) throw new Error(`field: ${fld.error.message}`);
}, 60_000);

afterAll(async () => {
  if (!admin) return;
  if (docPath) await admin.storage.from('originals').remove([docPath]);
  for (const u of [A, B]) {
    if (!u) continue;
    await admin.from('envelopes').delete().eq('org_id', u.orgId);
    await admin.from('organizations').delete().eq('id', u.orgId);
    await admin.auth.admin.deleteUser(u.id);
  }
}, 60_000);

describe('AT1.1 through the public API: a signed-in user sees only their own workspace', () => {
  it('A sees their own envelope, document, recipient and field', async () => {
    const [e, d, r, f] = await Promise.all([
      A.client.from('envelopes').select('id, public_code, status'),
      A.client.from('envelope_documents').select('id'),
      A.client.from('recipients').select('id, name, email'),
      A.client.from('fields').select('id'),
    ]);
    expect(e.data).toHaveLength(1);
    expect(e.data![0].status).toBe('draft');
    expect(isValidPublicCode(e.data![0].public_code)).toBe(true);
    expect(d.data).toHaveLength(1);
    expect(r.data).toHaveLength(1);
    expect(f.data).toHaveLength(1);
  });

  const tables: Array<[string, string, (u: TestUser) => [string, string]]> = [
    ['envelopes', 'id', (u) => ['org_id', u.orgId]],
    ['envelope_documents', 'id', (u) => ['org_id', u.orgId]],
    ['recipients', 'id', (u) => ['org_id', u.orgId]],
    ['fields', 'id', (u) => ['org_id', u.orgId]],
    ['audit_events', 'id', (u) => ['org_id', u.orgId]],
    ['folders', 'id', (u) => ['org_id', u.orgId]],
    ['organizations', 'id', (u) => ['id', u.orgId]],
    ['memberships', 'org_id', (u) => ['org_id', u.orgId]],
    ['org_settings', 'org_id', (u) => ['org_id', u.orgId]],
    ['profiles', 'id', (u) => ['id', u.id]],
    ['account_controls', 'user_id', (u) => ['user_id', u.id]],
  ];
  it.each(tables)('B cannot read A\'s rows in %s', async (table, column, filter) => {
    const [col, val] = filter(A);
    const res = await B.client.from(table).select(column).eq(col, val);
    expect(res.data ?? []).toHaveLength(0);
  });

  it('B\'s unfiltered envelope list is empty (nothing leaks without a filter)', async () => {
    const res = await B.client.from('envelopes').select('id');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(0);
  });

  it('B cannot create, rename or delete folders in A\'s workspace', async () => {
    const ins = await B.client.from('folders').insert({ org_id: A.orgId, name: 'intruder', created_by: B.id }).select('id');
    expect(ins.error).not.toBeNull();
    const upd = await B.client.from('folders').update({ name: 'hacked' }).eq('org_id', A.orgId).select('id');
    expect(upd.data ?? []).toHaveLength(0);
    const del = await B.client.from('folders').delete().eq('org_id', A.orgId).select('id');
    expect(del.data ?? []).toHaveLength(0);
    const still = await A.client.from('folders').select('name').eq('id', A.folderId).single();
    expect(still.data?.name).toBe('Completed');
  });

  it('A can manage folders in their own workspace', async () => {
    const ins = await A.client.from('folders').insert({ org_id: A.orgId, name: `Contracts ${run}`, created_by: A.id }).select('id').single();
    expect(ins.error).toBeNull();
    const del = await A.client.from('folders').delete().eq('id', ins.data!.id).select('id');
    expect(del.data).toHaveLength(1);
  });
});

describe('privilege escalation and server-only surfaces', () => {
  it('A cannot make themselves an administrator, approved, trusted or raise quotas', async () => {
    await A.client.from('account_controls').update({ is_platform_admin: true, approved: true, trust_level: 'trusted', storage_quota_bytes: 10 ** 12 }).eq('user_id', A.id);
    const truth = await admin.from('account_controls').select('is_platform_admin, approved, trust_level, storage_quota_bytes').eq('user_id', A.id).single();
    expect(truth.data).toEqual({ is_platform_admin: false, approved: false, trust_level: 'restricted', storage_quota_bytes: 52428800 });
  });

  it('A cannot change an envelope\'s status, code or owner directly', async () => {
    await A.client.from('envelopes').update({ status: 'completed', public_code: 'ES-2611-0000-0000-0000-00', sender_id: B.id }).eq('id', envA.id);
    const truth = await admin.from('envelopes').select('status, public_code, sender_id').eq('id', envA.id).single();
    expect(truth.data).toEqual({ status: 'draft', public_code: envA.public_code, sender_id: A.id });
  });

  it('A cannot call server-only functions', async () => {
    const a = await A.client.rpc('create_envelope', { p_actor: A.id, p_org_id: A.orgId, p_title: 'direct', p_folder_id: null });
    expect(a.error).not.toBeNull();
    const b = await A.client.rpc('rate_limit_hit', { p_bucket: 'x', p_key: 'y', p_limit: 1, p_window_seconds: 60 });
    expect(b.error).not.toBeNull();
  });

  it.each(['platform_settings', 'recipient_tokens', 'notification_outbox', 'org_controls', 'registration_requests', 'email_budget', 'rate_limits', 'usage_counters', 'abuse_reports', 'system_health'])(
    'service-only table %s returns nothing to a signed-in user',
    async (table) => {
      const res = await A.client.from(table).select('*').limit(1);
      expect(res.data ?? []).toHaveLength(0);
    },
  );

  it('the access-code hash cannot be read, even by the owner', async () => {
    const res = await A.client.from('recipients').select('access_code_hash');
    expect(res.error).not.toBeNull();
    expect(JSON.stringify(res.data ?? '')).not.toContain('not-a-real-hash');
  });

  it('A cannot write fields, recipients, documents or audit events directly', async () => {
    const f = await A.client.from('fields').update({ x: 0.9 }).eq('envelope_id', envA.id).select('id');
    const r = await A.client.from('recipients').insert({ org_id: A.orgId, envelope_id: envA.id, name: 'X', email: 'x@example.test' }).select('id');
    const d = await A.client.from('envelope_documents').delete().eq('envelope_id', envA.id).select('id');
    const au = await A.client.from('audit_events').delete().eq('envelope_id', envA.id).select('id');
    for (const res of [f, r, d, au]) expect(res.data ?? []).toHaveLength(0);
    const truth = await admin.from('fields').select('x').eq('envelope_id', envA.id).single();
    expect(Number(truth.data!.x)).toBeCloseTo(0.1);
  });

  it('with no sign-in at all, nothing is readable or callable', async () => {
    for (const t of ['envelopes', 'recipients', 'profiles', 'audit_events', 'folders', 'organizations']) {
      const res = await anon.from(t).select('*').limit(1);
      expect(res.data ?? []).toHaveLength(0);
    }
    const rpc = await anon.rpc('create_envelope', { p_actor: A.id, p_org_id: A.orgId, p_title: 'anon', p_folder_id: null });
    expect(rpc.error).not.toBeNull();
  });
});

describe('AT1.10 storage: private buckets and immutable originals (real uploads)', () => {
  it('neither the owner nor another user can download, list or upload through the public storage API', async () => {
    for (const u of [A, B]) {
      const dl = await u.client.storage.from('originals').download(docPath);
      expect(dl.error).not.toBeNull();
      const ls = await u.client.storage.from('originals').list(A.orgId);
      expect(ls.data ?? []).toHaveLength(0);
      const up = await u.client.storage.from('originals').upload(`${u.orgId}/x/y.pdf`, originalPdf, { contentType: 'application/pdf' });
      expect(up.error).not.toBeNull();
    }
    const signed = await B.client.storage.from('originals').createSignedUrl(docPath, 60);
    expect(signed.error).not.toBeNull();
  });

  it('even the server cannot overwrite an original, with or without the overwrite flag, and the stored bytes are unchanged', async () => {
    const other = await PDFDocument.create();
    other.addPage([300, 300]).drawText('TAMPERED');
    const tampered = await other.save();
    const plain = await admin.storage.from('originals').upload(docPath, tampered, { contentType: 'application/pdf', upsert: false });
    expect(plain.error).not.toBeNull();
    const forced = await admin.storage.from('originals').upload(docPath, tampered, { contentType: 'application/pdf', upsert: true });
    expect(forced.error).not.toBeNull();
    const upd = await admin.storage.from('originals').update(docPath, tampered, { contentType: 'application/pdf' });
    expect(upd.error).not.toBeNull();
    const back = await admin.storage.from('originals').download(docPath);
    expect(back.error).toBeNull();
    expect(sha(new Uint8Array(await back.data!.arrayBuffer()))).toBe(sha(originalPdf));
  });

  it('the server cannot move an original to another path', async () => {
    const mv = await admin.storage.from('originals').move(docPath, `${A.orgId}/${envA.id}/moved.pdf`);
    expect(mv.error).not.toBeNull();
  });
});

describe('AT1.9 audit chain as read through the API', () => {
  it('the chain for A\'s envelope verifies with the application\'s verifier (database and app agree on hashing)', async () => {
    const res = await A.client.from('audit_events').select('*').eq('envelope_id', envA.id).order('chain_seq');
    expect(res.error).toBeNull();
    const rows = res.data as unknown as AuditRow[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].event_type).toBe('envelope_created');
    const v = verifyChain(rows);
    expect(v).toMatchObject({ ok: true, count: rows.length });
  });

  it('a row altered after reading fails verification', async () => {
    const res = await A.client.from('audit_events').select('*').eq('envelope_id', envA.id).order('chain_seq');
    const rows = (res.data as unknown as AuditRow[]).map((r) => ({ ...r }));
    rows[0].event_type = 'recipient_signed';
    expect(verifyChain(rows).ok).toBe(false);
  });
});
