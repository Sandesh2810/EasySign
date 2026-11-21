// Make a draft from a template (D-77): the database creates the draft and its people, the server copies the template's
// file into the draft's own folder, then the database places the fields. If anything fails, the half-made draft and its
// copy are removed. Shared by "Use this template" (web) and bulk send (worker, D-85). Server-only: no Next.js imports.
import 'server-only';
import { friendlyDbError } from '@/lib/db-error';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export class TemplateUseError extends Error {}

export async function draftFromTemplate(actor: string, templateId: string, title: string, people: { role_id: string; name: string; email: string }[]): Promise<string> {
  const admin = supabaseAdmin();
  const started = await admin.rpc('template_start', { p_actor: actor, p_template_id: templateId, p_title: title, p_people: people });
  if (started.error || !started.data) throw new TemplateUseError(friendlyDbError(started.error?.message).message);
  const s = started.data as { envelope_id: string; org_id: string; source_backend: Backend; source_path: string };
  const target = `${s.org_id}/${s.envelope_id}/document.pdf`;
  const store = getStorageFor(s.source_backend);
  let copied = false;
  try {
    await store.put('originals', target, await store.get('originals', s.source_path), { contentType: 'application/pdf' });
    copied = true;
    const finished = await admin.rpc('template_finish', { p_actor: actor, p_envelope_id: s.envelope_id, p_template_id: templateId, p_storage_path: target });
    if (finished.error) throw new TemplateUseError(friendlyDbError(finished.error.message).message);
  } catch (e) {
    // undo the half-made draft so nothing is left behind
    if (copied) await store.remove('originals', target, { draftOnly: true }).catch(() => {});
    await admin.rpc('delete_draft_envelope', { p_actor: actor, p_envelope_id: s.envelope_id });
    throw e instanceof TemplateUseError ? e : new TemplateUseError(e instanceof Error && e.message ? e.message : 'The draft could not be made from the template.');
  }
  return s.envelope_id;
}
