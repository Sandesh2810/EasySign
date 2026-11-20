'use server';
// Templates (Phase 4 slice 2, AT4.1, D-77). The database functions decide who may do what (creator edits; shared templates
// are used by members and edited by the owner and administrators; viewers never). Files: a template keeps its own copy
// of the document at <workspace>/tpl-<id>/document.pdf, and each draft made from it gets its own copy again, so nothing
// is shared between a template and the documents made from it.
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export type TemplateResult = { ok: true; message: string } | { ok: false; message: string } | null;
const SORRY = 'Something went wrong. Nothing was changed. Try again.';
const nameSchema = z.string().trim().min(1, 'Give the template a name.').max(120, 'Template names can be up to 120 characters.');

/** "Save as template" from a document the person can see. */
export async function saveAsTemplateAction(_prev: TemplateResult, formData: FormData): Promise<TemplateResult> {
  const user = await requireUser();
  const envelopeId = z.uuid().safeParse(formData.get('envelope_id'));
  const name = nameSchema.safeParse(formData.get('name'));
  if (!envelopeId.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  if (!name.success) return { ok: false, message: name.error.issues[0]?.message ?? 'Check the name.' };
  // Read through the person's own session: row-level security shows the document only if they may see it.
  const supabase = await createSupabaseServerClient();
  const { data: doc } = await supabase
    .from('envelope_documents')
    .select('org_id, storage_backend, storage_path')
    .eq('envelope_id', envelopeId.data)
    .order('position')
    .limit(1)
    .maybeSingle();
  if (!doc) return { ok: false, message: 'Add a document first.' };
  const labels: { recipient_id: string; label: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('label_') && typeof value === 'string') labels.push({ recipient_id: key.slice(6), label: value.trim().slice(0, 60) });
  }

  const templateId = randomUUID();
  const target = `${doc.org_id}/tpl-${templateId}/document.pdf`;
  const store = getStorageFor(doc.storage_backend as Backend);
  try {
    await store.put('originals', target, await store.get('originals', doc.storage_path as string), { contentType: 'application/pdf' });
  } catch {
    return { ok: false, message: 'The document file could not be copied. Try again.' };
  }
  const { error } = await supabaseAdmin().rpc('template_create', {
    p_actor: user.id,
    p_template_id: templateId,
    p_envelope_id: envelopeId.data,
    p_name: name.data,
    p_shared: formData.get('shared') === 'on',
    p_labels: labels,
    p_storage_path: target,
  });
  if (error) {
    await store.remove('originals', target, { draftOnly: true }).catch(() => {}); // a template's file is never part of a sent document
    return { ok: false, message: friendlyDbError(error.message).message };
  }
  revalidatePath('/app/templates');
  return { ok: true, message: `Template “${name.data}” saved. Find it under Templates.` };
}

/** Start a new draft from a template: one person per role. */
export async function useTemplateAction(_prev: TemplateResult, formData: FormData): Promise<TemplateResult> {
  const user = await requireUser();
  const templateId = z.uuid().safeParse(formData.get('template_id'));
  if (!templateId.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const people: { role_id: string; name: string; email: string }[] = [];
  for (const [key, value] of formData.entries()) {
    const m = /^name_(.+)$/.exec(key);
    if (m && typeof value === 'string') people.push({ role_id: m[1], name: value.trim(), email: String(formData.get(`email_${m[1]}`) ?? '').trim() });
  }
  const title = String(formData.get('title') ?? '').trim().slice(0, 200);
  const admin = supabaseAdmin();
  const started = await admin.rpc('template_start', { p_actor: user.id, p_template_id: templateId.data, p_title: title, p_people: people });
  if (started.error || !started.data) return { ok: false, message: friendlyDbError(started.error?.message).message };
  const s = started.data as { envelope_id: string; org_id: string; source_backend: Backend; source_path: string };
  const target = `${s.org_id}/${s.envelope_id}/document.pdf`;
  const store = getStorageFor(s.source_backend);
  let copied = false;
  try {
    await store.put('originals', target, await store.get('originals', s.source_path), { contentType: 'application/pdf' });
    copied = true;
    const finished = await admin.rpc('template_finish', { p_actor: user.id, p_envelope_id: s.envelope_id, p_template_id: templateId.data, p_storage_path: target });
    if (finished.error) throw new Error(friendlyDbError(finished.error.message).message);
  } catch (e) {
    // undo the half-made draft so nothing is left behind
    if (copied) await store.remove('originals', target, { draftOnly: true }).catch(() => {});
    await admin.rpc('delete_draft_envelope', { p_actor: user.id, p_envelope_id: s.envelope_id });
    return { ok: false, message: e instanceof Error && e.message ? e.message : SORRY };
  }
  revalidatePath('/app');
  redirect(`/app/envelopes/${s.envelope_id}`);
}

export async function updateTemplateAction(_prev: TemplateResult, formData: FormData): Promise<TemplateResult> {
  const user = await requireUser();
  const templateId = z.uuid().safeParse(formData.get('template_id'));
  const name = nameSchema.safeParse(formData.get('name'));
  if (!templateId.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  if (!name.success) return { ok: false, message: name.error.issues[0]?.message ?? 'Check the name.' };
  const labels: { role_id: string; label: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('role_') && typeof value === 'string') labels.push({ role_id: key.slice(5), label: value.trim() });
  }
  const locked = formData.getAll('locked').map(String).filter((v) => z.uuid().safeParse(v).success);
  const { error } = await supabaseAdmin().rpc('template_update', {
    p_actor: user.id,
    p_template_id: templateId.data,
    p_name: name.data,
    p_shared: formData.get('shared') === 'on',
    p_labels: labels,
    p_locked_ids: locked,
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/templates/${templateId.data}`);
  revalidatePath('/app/templates');
  return { ok: true, message: 'Template saved. Documents already made from it are not changed.' };
}

export async function deleteTemplateAction(formData: FormData) {
  const user = await requireUser();
  const templateId = z.uuid().safeParse(formData.get('template_id'));
  if (!templateId.success) redirect('/app/templates');
  const { data: template } = await supabaseAdmin().rpc('template_get', { p_actor: user.id, p_template_id: templateId.data });
  const { data: path, error } = await supabaseAdmin().rpc('template_delete', { p_actor: user.id, p_template_id: templateId.data });
  if (!error && typeof path === 'string') {
    const backend = ((template as { storage_backend?: Backend } | null)?.storage_backend ?? 'supabase') as Backend;
    await getStorageFor(backend).remove('originals', path, { draftOnly: true }).catch(() => {}); // the file of a template is never part of a document
  }
  revalidatePath('/app/templates');
  redirect('/app/templates');
}
