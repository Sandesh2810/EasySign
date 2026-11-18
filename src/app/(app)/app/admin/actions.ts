'use server';
// Administrator actions. The database function re-checks that the acting user is a platform
// administrator (D-35); a non-administrator gets "not found", the same as for the page itself.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type AdminResult = { ok: true; message: string } | { ok: false; message: string };

export async function setApprovalAction(_prev: AdminResult | null, formData: FormData): Promise<AdminResult> {
  const user = await requireUser('/app/admin');
  const target = z.uuid().safeParse(formData.get('user_id'));
  const approve = formData.get('approve') === '1';
  if (!target.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  const { error } = await supabaseAdmin().rpc('admin_set_approval', { p_actor: user.id, p_user: target.data, p_approved: approve });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/admin');
  return { ok: true, message: approve ? 'Approved.' : 'Approval removed.' };
}
