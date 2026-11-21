// AT5.1 contract test against the RUNNING app (D-91): every operation in the OpenAPI document is called; every answer
// must match its response schema (the same Zod schemas the document is generated from, strict: no extra or missing
// fields), and every status code received must be one the document lists for that operation.
// Run: start the app, then  npm run test:api. Uses its own synthetic account, template and key.
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { z } from 'zod';
import { newApiKey } from '@/lib/api/keys';
import { openApiDocument } from '@/lib/api/openapi';
import { documentBody, errorBody, sendBody, templatesBody } from '@/lib/api/schemas';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const APP = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = 'api-contract@example.test';
let db: SupabaseClient;
let key = '';
let readKey = '';
let templateId = '';
let documentId = '';
const tag = randomBytes(3).toString('hex');

const spec = openApiDocument(APP) as { paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>> };
const documented = (operationId: string) => {
  for (const methods of Object.values(spec.paths)) for (const op of Object.values(methods)) if (op.operationId === operationId) return Object.keys(op.responses);
  throw new Error(`no operation ${operationId}`);
};
const called = new Set<string>();

async function call(operationId: string, k: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${APP}/api/v1${path}`, {
    method,
    headers: { ...(k ? { Authorization: `Bearer ${k}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 250) + 1}`, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  called.add(operationId);
  expect(documented(operationId), `${operationId} answered ${res.status}, which the OpenAPI document does not list`).toContain(String(res.status));
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, type, json: type.includes('application/json') ? await res.json() : null };
}
const conforms = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues).slice(0, 500)).toBe(true);
};

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

beforeAll(async () => {
  db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
  let u = list.data?.users.find((x) => x.email === EMAIL);
  if (!u) u = (await db.auth.admin.createUser({ email: EMAIL, password: randomBytes(24).toString('base64url'), email_confirm: true, user_metadata: { full_name: 'Cora Contract' } })).data.user!;
  await db.from('account_controls').update({ approved: true, trust_level: 'trusted', daily_envelope_cap: 100, daily_recipient_cap: 100 }).eq('user_id', u.id);
  const { data: m } = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner').single();
  const org = m!.org_id as string;
  for (const k of ((await rpc('api_key_list', { p_actor: u.id, p_org: org })) as { id: string; revoked_at: string | null }[]).filter((k) => !k.revoked_at)) await rpc('revoke_api_key', { p_actor: u.id, p_key_id: k.id });
  // a one-person template
  const env = (await rpc('create_envelope', { p_actor: u.id, p_org_id: org, p_title: `Contract source ${tag}`, p_folder_id: null })) as { id: string };
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Contract ${randomUUID()}`, { x: 72, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await pdf.save();
  const src = `${org}/${env.id}/doc1.pdf`;
  await db.storage.from('originals').upload(src, bytes, { contentType: 'application/pdf', upsert: false });
  const doc = (await rpc('add_envelope_document', { p_actor: u.id, p_envelope_id: env.id, p_filename: 'c.pdf', p_storage_backend: 'supabase', p_storage_path: src,
    p_sha256: createHash('sha256').update(bytes).digest('hex'), p_page_count: 1, p_size_bytes: bytes.length, p_page_boxes: [], p_source_kind: 'pdf' })) as { id: string };
  const [r] = (await rpc('save_recipients', { p_actor: u.id, p_envelope_id: env.id, p_recipients: [{ name: 'Buyer', email: `contract-buyer-${tag}@example.test`, role: 'signer', routing_order: 1 }] })) as { id: string }[];
  await rpc('save_fields', { p_actor: u.id, p_envelope_id: env.id, p_fields: [{ document_id: doc.id, recipient_id: r.id, type: 'signature', page: 1, x: 0.1, y: 0.7, w: 0.35, h: 0.07 }] });
  templateId = randomUUID();
  const tplPath = `${org}/tpl-${templateId}/document.pdf`;
  await db.storage.from('originals').copy(src, tplPath);
  await rpc('template_create', { p_actor: u.id, p_template_id: templateId, p_envelope_id: env.id, p_name: `Contract ${tag}`, p_shared: true, p_labels: [{ recipient_id: r.id, label: 'Buyer' }], p_storage_path: tplPath });
  const full = newApiKey();
  await rpc('create_api_key', { p_actor: u.id, p_org: org, p_name: `Contract ${tag}`, p_scopes: ['documents:read', 'documents:write', 'documents:send'], p_prefix: full.prefix, p_key_sha256: full.sha256 });
  key = full.key;
  const ro = newApiKey();
  await rpc('create_api_key', { p_actor: u.id, p_org: org, p_name: `Contract read ${tag}`, p_scopes: ['documents:read'], p_prefix: ro.prefix, p_key_sha256: ro.sha256 });
  readKey = ro.key;
});

describe('AT5.1 the API answers exactly as its OpenAPI document says (D-91)', () => {
  it('serves the document it is generated from', async () => {
    const res = await fetch(`${APP}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(spec);
  });

  it('listTemplates', async () => {
    const r = await call('listTemplates', key, 'GET', '/templates');
    expect(r.status).toBe(200);
    conforms(templatesBody, r.json);
  });

  it('createDocument: 201 and the documented errors', async () => {
    const body = { template_id: templateId, people: [{ role: 'Buyer', name: 'Bea Buyer', email: `contract-bea-${tag}@example.test` }] };
    const r = await call('createDocument', key, 'POST', '/documents', body, { 'Idempotency-Key': `c-${tag}` });
    expect(r.status).toBe(201);
    conforms(documentBody, r.json);
    documentId = r.json.id;
    const replay = await call('createDocument', key, 'POST', '/documents', body, { 'Idempotency-Key': `c-${tag}` });
    expect(replay.json.id).toBe(documentId);
    for (const [status, req] of [
      [400, { template_id: 'not-a-uuid', people: [] }],
      [404, { ...body, template_id: randomUUID() }],
      [422, { ...body, people: [{ role: 'Nobody', name: 'X', email: `x-${tag}@example.test` }] }],
    ] as const) {
      const e = await call('createDocument', key, 'POST', '/documents', req);
      expect(e.status).toBe(status);
      conforms(errorBody, e.json);
    }
    const bad = await call('createDocument', key, 'POST', '/documents', '{not json');
    expect(bad.status).toBe(400);
    conforms(errorBody, bad.json);
    const mismatch = await call('createDocument', key, 'POST', '/documents', { ...body, title: 'Other' }, { 'Idempotency-Key': `c-${tag}` });
    expect(mismatch.status).toBe(422);
    conforms(errorBody, mismatch.json);
  });

  it('getDocument', async () => {
    const r = await call('getDocument', key, 'GET', `/documents/${documentId}`);
    expect(r.status).toBe(200);
    conforms(documentBody, r.json);
    const missing = await call('getDocument', key, 'GET', `/documents/${randomUUID()}`);
    expect(missing.status).toBe(404);
    conforms(errorBody, missing.json);
    const anon = await call('getDocument', null, 'GET', `/documents/${documentId}`);
    expect(anon.status).toBe(401);
    conforms(errorBody, anon.json);
  });

  it('downloadDocument before completion: 409', async () => {
    const r = await call('downloadDocument', key, 'GET', `/documents/${documentId}/download?part=sealed`);
    expect(r.status).toBe(409);
    conforms(errorBody, r.json);
    const badPart = await call('downloadDocument', key, 'GET', `/documents/${documentId}/download?part=other`);
    expect(badPart.status).toBe(400);
  });

  it('sendDocument: 403 without the permission, then 200', async () => {
    const forbidden = await call('sendDocument', readKey, 'POST', `/documents/${documentId}/send`, { delivery: 'link' });
    expect(forbidden.status).toBe(403);
    conforms(errorBody, forbidden.json);
    const r = await call('sendDocument', key, 'POST', `/documents/${documentId}/send`, { delivery: 'link', expires_in_days: 7 });
    expect(r.status).toBe(200);
    conforms(sendBody, r.json);
    const again = await call('sendDocument', key, 'POST', `/documents/${documentId}/send`, { delivery: 'link' });
    expect(again.status).toBe(422);
    conforms(errorBody, again.json);
  });

  it('429 with Retry-After, as documented', async () => {
    const { data: row } = await db.from('api_keys').select('id').eq('key_sha256', createHash('sha256').update(readKey).digest('hex')).single();
    // the limit counts per clock minute: fill it all at once, early enough in a minute that the next request is in the same one
    const intoMinute = (Date.now() / 1000) % 60;
    if (intoMinute > 45) await new Promise((r) => setTimeout(r, (61 - intoMinute) * 1000));
    await Promise.all(Array.from({ length: 60 }, () => rpc('rate_limit_hit', { p_bucket: 'api_key', p_key: row!.id, p_limit: 60, p_window_seconds: 60 })));
    const r = await call('listTemplates', readKey, 'GET', '/templates');
    expect(r.status).toBe(429);
    conforms(errorBody, r.json);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('every operation in the document was called', () => {
    const all = Object.values(spec.paths).flatMap((m) => Object.values(m).map((o) => o.operationId));
    expect([...called].sort()).toEqual(all.sort());
  });
});
