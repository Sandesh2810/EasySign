// D-90: what the API does with documents, as the key's creator. Every step goes through the same database functions
// as the app (which check access and limits again). Server-only.
import 'server-only';
import { z } from 'zod';
import { friendlyDbError } from '@/lib/db-error';
import { sendProblems, toLogicFields } from '@/lib/form-logic';
import { byteaToBuffer, mintTokenRecord, signingLink } from '@/lib/signing/links';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { draftFromTemplate, TemplateUseError } from '@/lib/template-use';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';
import type { ApiContext } from './http';

export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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

export const createInput = z.object({
  template_id: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  people: z
    .array(z.object({ role: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().max(254).pipe(z.email()) }))
    .min(1)
    .max(50),
});

/** A new draft from a template; each person names a role by its id or its label. */
export async function createFromTemplate(ctx: ApiContext, input: z.infer<typeof createInput>): Promise<Record<string, unknown>> {
  const admin = supabaseAdmin();
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
  return viewDocument(ctx, id);
}

export const sendInput = z.object({
  delivery: z.enum(['email', 'link']),
  expires_in_days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]).default(30),
});

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
  const doc = await viewDocument(ctx, id);
  if (input.delivery !== 'link') return { document: doc };
  const { data: links, error } = await admin.rpc('reveal_signing_links', { p_actor: ctx.userId, p_envelope_id: id });
  if (error) throw fromDb(error.message);
  return {
    document: doc,
    signing_links: ((links ?? []) as { token_id: string; nonce_hex: string; recipient_name: string; recipient_role: string; recipient_order: number }[]).map((l) => ({
      name: l.recipient_name,
      role: l.recipient_role,
      order: l.recipient_order,
      url: signingLink(l.token_id, byteaToBuffer(l.nonce_hex)),
    })),
  };
}

/** The sealed PDF or its certificate of a completed document. */
export async function downloadDocument(ctx: ApiContext, id: string, part: 'sealed' | 'certificate'): Promise<{ bytes: Uint8Array; filename: string }> {
  const view = await viewDocument(ctx, id);
  const { data: env } = await supabaseAdmin().from('envelopes').select('title, status, sealed_storage_backend, sealed_storage_path, certificate_storage_path').eq('id', id).single();
  if (!env || env.status !== 'completed' || !env.sealed_storage_path || !env.certificate_storage_path) {
    throw new ApiFailure(409, 'not_completed', `The document is not completed yet (status: ${String(view.status)}).`);
  }
  const bytes = await getStorageFor(env.sealed_storage_backend as Backend).get('sealed', (part === 'certificate' ? env.certificate_storage_path : env.sealed_storage_path) as string);
  const base = String(env.title).replace(/[^A-Za-z0-9 _.-]+/g, '').trim().slice(0, 80) || 'document';
  return { bytes, filename: `${base}${part === 'certificate' ? ' - certificate' : ' - signed'}.pdf` };
}
