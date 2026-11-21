// D-90: what the API does with documents, as the key's creator. Every step goes through the same database functions
// as the app (which check access and limits again). Server-only.
import 'server-only';
import type { z } from 'zod';
import { createInput, sendInput } from './schemas';
import { friendlyDbError } from '@/lib/db-error';
import { sendProblems, toLogicFields } from '@/lib/form-logic';
import { byteaToBuffer, mintTokenRecord, signingLink } from '@/lib/signing/links';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { draftFromTemplate, TemplateUseError } from '@/lib/template-use';
import { allow } from '@/lib/rate-limit';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';
import type { ApiContext } from './http';
import { retryAfterSeconds } from './keys';
import { API_CREATE_DAILY, API_DOWNLOAD_HOURLY } from './limits';

export { createInput, sendInput };

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** A database refusal as an API error: "not found" for anything about access, 422 for what the caller can fix. */
function fromDb(message: string | undefined): ApiFailure {
  const f = friendlyDbError(message);
  if (f.code === 'ES_NOT_FOUND' || f.code === 'ES_ERROR') return new ApiFailure(f.code === 'ES_ERROR' ? 500 : 404, f.code === 'ES_ERROR' ? 'server_error' : 'not_found', f.message);
  if (f.code === 'ES_ENVELOPE_CAP' || f.code === 'ES_RECIPIENT_CAP') return new ApiFailure(429, 'daily_limit', f.message);
  return new ApiFailure(422, f.code.replace(/^ES_/, '').toLowerCase(), f.message);
}

/** D-98: what a key did to a document goes in that document's audit trail, naming the key. */
async function auditApi(ctx: ApiContext, id: string, action: 'created_from_template' | 'sent'): Promise<void> {
  const { error } = await supabaseAdmin().rpc('api_audit', { p_key_id: ctx.keyId, p_envelope_id: id, p_action: action });
  if (error) console.error('[api] audit record failed', error.message);
}

export async function viewDocument(ctx: ApiContext, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin().rpc('api_document_view', { p_actor: ctx.userId, p_org: ctx.orgId, p_envelope_id: id });
  if (error) throw fromDb(error.message);
  return data as Record<string, unknown>;
}

export async function listTemplates(ctx: ApiContext): Promise<unknown[]> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('template_list', { p_actor: ctx.userId, p_org: ctx.orgId });
  if (error) throw fromDb(error.message);
  const list = (data ?? []) as { id: string; name: string }[];
  if (!list.length) return [];
  const { data: roles } = await admin.from('template_roles').select('id, template_id, label, role, routing_order').in('template_id', list.map((t) => t.id)).order('position');
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    roles: (roles ?? []).filter((r) => r.template_id === t.id).map((r) => ({ id: r.id, label: r.label, role: r.role, order: r.routing_order })),
  }));
}

/** A new draft from a template; each person names a role by its id or its label. */
export async function createFromTemplate(ctx: ApiContext, input: z.infer<typeof createInput>): Promise<Record<string, unknown>> {
  const admin = supabaseAdmin();
  if (!(await allow(API_CREATE_DAILY, ctx.userId))) {
    throw new ApiFailure(429, 'daily_limit', `At most ${API_CREATE_DAILY.limit} documents a day can be created through the API per person.`, { 'Retry-After': String(retryAfterSeconds(API_CREATE_DAILY.windowSeconds)) });
  }
  const { data: tpl, error } = await admin.rpc('template_get', { p_actor: ctx.userId, p_template_id: input.template_id });
  const t = tpl as { name: string; org_id: string; roles: { id: string; label: string }[] } | null;
  // a key works only in its own workspace, even if its creator also belongs to another one
  if (error || !t || t.org_id !== ctx.orgId) throw new ApiFailure(404, 'not_found', 'Template not found.');
  const people = input.people.map((p) => {
    const role = t.roles.find((r) => r.id === p.role || r.label.toLowerCase() === p.role.toLowerCase());
    if (!role) throw new ApiFailure(422, 'unknown_role', `"${p.role}" is not a role of this template. Its roles are: ${t.roles.map((r) => r.label).join(', ')}.`);
    return { role_id: role.id, name: p.name, email: p.email };
  });
  let id: string;
  try {
    id = await draftFromTemplate(ctx.userId, input.template_id, input.title ?? t.name, people);
  } catch (e) {
    if (e instanceof TemplateUseError) throw new ApiFailure(422, 'cannot_create', e.message);
    throw e;
  }
  await auditApi(ctx, id, 'created_from_template');
  return viewDocument(ctx, id);
}

/**
 * Sends a draft, with the same checks as the app's send step (formulas and conditions in full; the database checks
 * the rest). With delivery "link" the answer includes each person's signing link to pass on (treat them like keys).
 */
export async function sendDocument(ctx: ApiContext, id: string, input: z.infer<typeof sendInput>): Promise<Record<string, unknown>> {
  await viewDocument(ctx, id); // access first: nothing is read for a document this key may not handle
  const admin = supabaseAdmin();
  const { data: fieldRows } = await admin.from('fields').select('id, type, page, recipient_id, options').eq('envelope_id', id).order('page').order('y').order('x');
  const notReady = sendProblems(toLogicFields(fieldRows ?? []));
  if (notReady.length) throw new ApiFailure(422, 'not_ready', `Not ready to send. ${notReady[0]}`);
  const { data: people } = await admin.from('recipients').select('id').eq('envelope_id', id).neq('role', 'cc');
  const tokens = (people ?? []).map((r) => mintTokenRecord(r.id as string));
  const [after, every, max] = input.delivery === 'email' ? [3, 3, 3] : [null, null, 0];
  const reminders = await admin.rpc('set_reminders', { p_actor: ctx.userId, p_envelope_id: id, p_after_days: after, p_every_days: every, p_max: max });
  if (reminders.error) throw fromDb(reminders.error.message);
  const expires = new Date(Date.now() + input.expires_in_days * 86400_000).toISOString();
  const sent = await admin.rpc('send_envelope', { p_actor: ctx.userId, p_envelope_id: id, p_tokens: tokens, p_expires_at: expires, p_delivery: input.delivery });
  if (sent.error) throw fromDb(sent.error.message);
  await auditApi(ctx, id, 'sent');
  const doc = await viewDocument(ctx, id);
  if (input.delivery !== 'link') return { document: doc };
  return { document: doc, signing_links: await signingLinks(ctx, id) };
}

/** Each person's signing link of an open document, made fresh from the database (links are never stored). */
export async function signingLinks(ctx: ApiContext, id: string): Promise<{ name: string; role: string; order: number; url: string }[]> {
  const { data: links, error } = await supabaseAdmin().rpc('reveal_signing_links', { p_actor: ctx.userId, p_envelope_id: id });
  if (error) throw fromDb(error.message);
  return ((links ?? []) as { token_id: string; nonce_hex: string; recipient_name: string; recipient_role: string; recipient_order: number }[]).map((l) => ({
    name: l.recipient_name,
    role: l.recipient_role,
    order: l.recipient_order,
    url: signingLink(l.token_id, byteaToBuffer(l.nonce_hex)),
  }));
}

/**
 * D-98: a send answer is stored for replay without its signing links (they work like keys); a replay of it gets the
 * links again from the database while the document is still open for signing, and an empty list once it is not.
 */
export function sendAnswerToStore(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !('signing_links' in body)) return body;
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest.signing_links;
  return { ...rest, signing_links_redacted: true };
}
export async function sendAnswerReplay(ctx: ApiContext, id: string, stored: unknown): Promise<unknown> {
  if (!stored || typeof stored !== 'object' || !('signing_links_redacted' in stored)) return stored;
  const rest: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  delete rest.signing_links_redacted;
  const links = await signingLinks(ctx, id).catch(() => []);
  return { ...rest, signing_links: links };
}

/** The sealed PDF or its certificate of a completed document. */
export async function downloadDocument(ctx: ApiContext, id: string, part: 'sealed' | 'certificate'): Promise<{ bytes: Uint8Array; filename: string }> {
  const view = await viewDocument(ctx, id);
  if (!(await allow(API_DOWNLOAD_HOURLY, ctx.keyId))) {
    throw new ApiFailure(429, 'rate_limited', `At most ${API_DOWNLOAD_HOURLY.limit} downloads an hour per key.`, { 'Retry-After': String(retryAfterSeconds(API_DOWNLOAD_HOURLY.windowSeconds)) });
  }
  const { data: env } = await supabaseAdmin().from('envelopes').select('title, status, sealed_storage_backend, sealed_storage_path, certificate_storage_path').eq('id', id).single();
  if (!env || env.status !== 'completed' || !env.sealed_storage_path || !env.certificate_storage_path) {
    throw new ApiFailure(409, 'not_completed', `The document is not completed yet (status: ${String(view.status)}).`);
  }
  const bytes = await getStorageFor(env.sealed_storage_backend as Backend).get('sealed', (part === 'certificate' ? env.certificate_storage_path : env.sealed_storage_path) as string);
  const base = String(env.title).replace(/[^A-Za-z0-9 _.-]+/g, '').trim().slice(0, 80) || 'document';
  return { bytes, filename: `${base}${part === 'certificate' ? ' - certificate' : ' - signed'}.pdf` };
}
