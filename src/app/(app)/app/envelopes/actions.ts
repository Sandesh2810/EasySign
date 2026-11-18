'use server';
// Actions on a draft envelope. Each one establishes the user first, then calls a server-only database
// function that re-checks that user's membership (DECISIONS D-35).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { fieldsSchema } from '@/lib/fields';
import { friendlyDbError } from '@/lib/request-guard';
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
