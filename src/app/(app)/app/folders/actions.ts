'use server';
// Folders and filing rules. Creating, renaming and deleting a folder go through the user's own session
// (row-level security allows members to do exactly that). Filing rules and moving a document go through
// server-only database functions that re-check membership (D-35).
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type FolderResult = { ok: true; message: string } | { ok: false; message: string } | null;
const name = z.string().trim().min(1, 'Give the folder a name.').max(120, 'Folder names can be up to 120 characters.');

async function myOrg(userId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('memberships').select('org_id, role').eq('user_id', userId).in('role', ['owner', 'admin', 'member']).limit(1).maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

export async function createFolderAction(_prev: FolderResult, formData: FormData): Promise<FolderResult> {
  const user = await requireUser('/app/folders');
  const parsed = name.safeParse(formData.get('name'));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the name.' };
  const org = await myOrg(user.id);
  if (!org) return { ok: false, message: 'You cannot add folders in this workspace.' };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('folders').insert({ org_id: org, name: parsed.data, created_by: user.id });
  if (error) return { ok: false, message: 'The folder could not be created. Try again.' };
  revalidatePath('/app/folders');
  return { ok: true, message: `Folder “${parsed.data}” created.` };
}

export async function deleteFolderAction(_prev: FolderResult, formData: FormData): Promise<FolderResult> {
  await requireUser('/app/folders');
  const id = z.uuid().safeParse(formData.get('folder_id'));
  if (!id.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const supabase = await createSupabaseServerClient();
  // Documents in a deleted folder are not deleted: they simply have no folder afterwards. Its filing rules go with it.
  const { error, count } = await supabase.from('folders').delete({ count: 'exact' }).eq('id', id.data);
  if (error || !count) return { ok: false, message: 'The folder could not be deleted. Try again.' };
  revalidatePath('/app/folders');
  return { ok: true, message: 'Folder deleted. Its documents are still there, without a folder.' };
}

export async function addRuleAction(_prev: FolderResult, formData: FormData): Promise<FolderResult> {
  const user = await requireUser('/app/folders');
  const parsed = z
    .object({ folder_id: z.uuid(), words: z.string().trim().min(2, 'Type at least 2 characters to look for.').max(100) })
    .safeParse({ folder_id: formData.get('folder_id'), words: formData.get('words') });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the rule.' };
  const org = await myOrg(user.id);
  if (!org) return { ok: false, message: 'You cannot add rules in this workspace.' };
  const { error } = await supabaseAdmin().rpc('set_filing_rule', { p_actor: user.id, p_org_id: org, p_folder_id: parsed.data.folder_id, p_title_contains: parsed.data.words, p_position: 0 });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/folders');
  return { ok: true, message: 'Rule added. It applies to documents completed from now on.' };
}

export async function deleteRuleAction(_prev: FolderResult, formData: FormData): Promise<FolderResult> {
  const user = await requireUser('/app/folders');
  const id = z.uuid().safeParse(formData.get('rule_id'));
  if (!id.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const { error } = await supabaseAdmin().rpc('delete_filing_rule', { p_actor: user.id, p_rule_id: id.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/folders');
  return { ok: true, message: 'Rule removed.' };
}

/** Move one document to another folder (or to no folder). */
export async function moveToFolderAction(_prev: FolderResult, formData: FormData): Promise<FolderResult> {
  const user = await requireUser();
  const parsed = z.object({ envelope_id: z.uuid(), folder_id: z.union([z.uuid(), z.literal('')]) }).safeParse({ envelope_id: formData.get('envelope_id'), folder_id: formData.get('folder_id') ?? '' });
  if (!parsed.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const { data, error } = await supabaseAdmin().rpc('move_to_folder', { p_actor: user.id, p_envelope_id: parsed.data.envelope_id, p_folder_id: parsed.data.folder_id || null });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${parsed.data.envelope_id}`);
  return { ok: true, message: data ? 'Moved.' : 'It was already there.' };
}
