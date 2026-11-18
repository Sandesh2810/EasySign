'use server';
// Actions on a draft envelope. Each one establishes the user first, then calls a server-only database
// function that re-checks that user's membership (DECISIONS D-35).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { fieldsSchema } from '@/lib/fields';
import { friendlyDbError } from '@/lib/request-guard';
import { assignOrders, MAX_RECIPIENTS, validateRouting } from '@/lib/routing';
import { mintTokenRecord, signingLink } from '@/lib/signing/links';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

const recipientsSchema = z.object({
  mode: z.enum(['sequential', 'parallel', 'mixed']),
  recipients: z
    .array(
      z.object({
        id: z.uuid().nullable(),
        name: z.string().trim().min(1, 'Enter a name for every person.').max(120, 'Names can be up to 120 characters.'),
        email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address for every person.')),
        role: z.enum(['signer', 'approver', 'viewer', 'cc']),
        order: z.number().int().min(1).max(99),
      }),
    )
    .min(1, 'Add at least one person who signs.')
    .max(MAX_RECIPIENTS, `A document can have up to ${MAX_RECIPIENTS} people.`),
});

/**
 * Save everyone involved in a draft, in list order, together with how they take turns (D-52).
 * For "one after another" and "all at once" the turn numbers are worked out here from the list order;
 * for "custom order" the numbers the sender typed are used.
 */
export async function saveRecipientsAction(envelopeId: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(envelopeId);
  const parsed = recipientsSchema.safeParse(input);
  if (!id.success) return { ok: false, message: 'Document not found.' };
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the list of people.' };
  const { mode, recipients } = parsed.data;

  const orders = mode === 'mixed' ? recipients.map((r) => r.order) : assignOrders(mode, recipients.map((r) => r.role));
  const verdict = validateRouting(recipients.map((r, i) => ({ id: String(i), role: r.role, order: orders[i], status: 'created' as const })), mode);
  if (!verdict.ok) return { ok: false, message: verdict.message };
  const seen = new Set<string>();
  for (const r of recipients) {
    const key = `${r.email}|${r.role}`;
    if (seen.has(key)) return { ok: false, message: `${r.email} is listed twice with the same role. Remove one of them.` };
    seen.add(key);
  }

  const me = (user.email ?? '').toLowerCase();
  const admin = supabaseAdmin();
  const routing = await admin.rpc('set_routing_mode', { p_actor: user.id, p_envelope_id: id.data, p_mode: mode });
  if (routing.error) return { ok: false, message: friendlyDbError(routing.error.message).message };
  const { error } = await admin.rpc('save_recipients', {
    p_actor: user.id,
    p_envelope_id: id.data,
    p_recipients: recipients.map((r, i) => ({ id: r.id, name: r.name, email: r.email, role: r.role, routing_order: orders[i], is_sender: r.email === me })),
  });
  if (error) {
    const friendly = friendlyDbError(error.message);
    return { ok: false, message: /recipients_unique_email/.test(error.message) ? 'The same email address is listed twice with the same role.' : friendly.message };
  }
  revalidatePath(`/app/envelopes/${id.data}`);
  return { ok: true, message: 'Saved.' };
}

/** Autosave from the field editor. The whole layout is sent each time; the database replaces it atomically. */
export async function saveFieldsAction(envelopeId: string, fields: unknown): Promise<ActionResult & { hash?: string }> {
  const user = await requireUser();
  const id = z.uuid().safeParse(envelopeId);
  const parsed = fieldsSchema.safeParse(fields);
  if (!id.success || !parsed.success) return { ok: false, message: 'Those fields could not be saved. Reload the page and try again.' };
  const { data, error } = await supabaseAdmin().rpc('save_fields', { p_actor: user.id, p_envelope_id: id.data, p_fields: parsed.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  return { ok: true, hash: data as string };
}

const LINK_TTL_DAYS = 30;

/**
 * Send the document. delivery "email" queues the request email (written to the dev outbox in log mode);
 * "link" sends nothing and lets the sender share the link themselves (zero email cost).
 */
export async function sendEnvelopeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get('envelope_id'));
  const delivery = z.enum(['email', 'link']).safeParse(formData.get('delivery'));
  if (!id.success || !delivery.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };

  const admin = supabaseAdmin();
  // The recipient ids are only used to prepare link records; send_envelope itself verifies that this
  // user may send this envelope and that the records match its signers.
  // Everyone except copy-only recipients gets a link record (D-52): signers, approvers and viewers.
  const signers = await admin.from('recipients').select('id').eq('envelope_id', id.data).neq('role', 'cc');
  const tokens = (signers.data ?? []).map((r) => mintTokenRecord(r.id as string));
  const expires = new Date(Date.now() + LINK_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const { error } = await admin.rpc('send_envelope', { p_actor: user.id, p_envelope_id: id.data, p_tokens: tokens, p_expires_at: expires, p_delivery: delivery.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${id.data}`);
  return { ok: true, message: delivery.data === 'email' ? 'Sent. The signer will receive an email with their link.' : 'Ready. Copy the signing link below and share it with the signer.' };
}

/** The sender asks for the signing link to share it themselves. Only members of the workspace get it. */
export interface RevealedLink {
  name: string;
  role: string;
  order: number;
  status: string;
  link: string;
}

export async function getSigningLinkAction(envelopeId: string): Promise<{ ok: true; links: RevealedLink[] } | { ok: false; message: string }> {
  const user = await requireUser();
  const id = z.uuid().safeParse(envelopeId);
  if (!id.success) return { ok: false, message: 'Document not found.' };
  // The database function checks that this user is a member (not a viewer, not suspended) of the
  // document's workspace and that the document is open, and writes "link_revealed" to the audit trail.
  const rows = await supabaseAdmin().rpc('reveal_signing_links', { p_actor: user.id, p_envelope_id: id.data });
  if (rows.error) return { ok: false, message: friendlyDbError(rows.error.message).message };
  type Row = { token_id: string; nonce_hex: string; recipient_name: string; recipient_role: string; recipient_order: number; recipient_status: string };
  const links = ((rows.data ?? []) as Row[]).map((t) => ({
    name: t.recipient_name,
    role: t.recipient_role,
    order: t.recipient_order,
    status: t.recipient_status,
    link: signingLink(t.token_id, Buffer.from(t.nonce_hex, 'hex')),
  }));
  return { ok: true, links };
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get('envelope_id'));
  if (!id.success) redirect('/app');
  const { data, error } = await supabaseAdmin().rpc('delete_draft_envelope', { p_actor: user.id, p_envelope_id: id.data });
  if (!error) {
    // The database row is gone; now remove the stored file so it stops counting against storage.
    for (const row of (data ?? []) as { storage_backend: Backend; storage_path: string }[]) {
      await getStorageFor(row.storage_backend).remove('originals', row.storage_path, { draftOnly: true }).catch(() => {});
    }
  }
  redirect('/app');
}
