'use server';
// Actions on a draft envelope. Each one establishes the user first, then calls a server-only database
// function that re-checks that user's membership (DECISIONS D-35).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { fieldsSchema } from '@/lib/fields';
import { friendlyDbError } from '@/lib/request-guard';
import { mintTokenRecord, signingLink } from '@/lib/signing/links';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

const recipientSchema = z.object({
  envelope_id: z.uuid(),
  name: z.string().trim().min(1, 'Enter the signer\'s name.').max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address.')),
});

/** Phase 1: one signer per document. "Sign it myself" fills in the sender's own details. */
export async function saveRecipientAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const self = formData.get('self') === '1';
  const admin = supabaseAdmin();
  let name = formData.get('name');
  let email = formData.get('email');
  if (self) {
    const profile = await admin.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
    name = profile.data?.display_name || 'Me';
    email = user.email ?? '';
  }
  const parsed = recipientSchema.safeParse({ envelope_id: formData.get('envelope_id'), name, email });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the signer\'s details.' };
  const isSender = self || parsed.data.email === (user.email ?? '').toLowerCase();

  const existing = await admin.from('recipients').select('id').eq('envelope_id', parsed.data.envelope_id).order('routing_order').limit(1).maybeSingle();
  const { error } = await admin.rpc('save_recipients', {
    p_actor: user.id,
    p_envelope_id: parsed.data.envelope_id,
    p_recipients: [{ id: existing.data?.id ?? null, name: parsed.data.name, email: parsed.data.email, role: 'signer', routing_order: 1, is_sender: isSender }],
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${parsed.data.envelope_id}`);
  return { ok: true, message: 'Signer saved.' };
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
