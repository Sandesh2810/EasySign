'use server';
// Administrator actions. The database function re-checks that the acting user is a platform
// administrator (D-35); a non-administrator gets "not found", the same as for the page itself.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type AdminResult = { ok: true; message: string } | { ok: false; message: string };

const uuid = z.uuid();

/** Suspend an account (its open documents go on hold) or lift the suspension. */
export async function setSuspensionAction(_prev: AdminResult | null, formData: FormData): Promise<AdminResult> {
  const user = await requireUser('/app/admin');
  const target = uuid.safeParse(formData.get('user_id'));
  const suspend = formData.get('suspend') === '1';
  const reason = z.string().trim().max(500).safeParse(formData.get('reason') ?? '');
  if (!target.success || !reason.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  if (suspend && formData.get('confirm') !== 'on') return { ok: false, message: 'Tick the box to confirm that you want to suspend this account.' };
  const { data, error } = await supabaseAdmin().rpc('admin_set_suspension', { p_actor: user.id, p_user: target.data, p_suspended: suspend, p_reason: reason.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/admin');
  return { ok: true, message: data === 'unchanged' ? 'Nothing changed.' : suspend ? 'Suspended. Their open documents are on hold.' : 'Suspension lifted. Their documents continue.' };
}

/** Daily limits and the "trusted" mark for one account. */
export async function setLimitsAction(_prev: AdminResult | null, formData: FormData): Promise<AdminResult> {
  const user = await requireUser('/app/admin');
  const parsed = z
    .object({ user_id: z.uuid(), documents: z.coerce.number().int().min(0).max(500), people: z.coerce.number().int().min(0).max(2000) })
    .safeParse({ user_id: formData.get('user_id'), documents: formData.get('documents'), people: formData.get('people') });
  if (!parsed.success) return { ok: false, message: 'Documents per day must be 0 to 500 and people per day 0 to 2000.' };
  const { error } = await supabaseAdmin().rpc('admin_set_limits', {
    p_actor: user.id,
    p_user: parsed.data.user_id,
    p_daily_envelope_cap: parsed.data.documents,
    p_daily_recipient_cap: parsed.data.people,
    p_trusted: formData.get('trusted') === 'on',
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/admin');
  return { ok: true, message: 'Saved.' };
}

/** Close an abuse report as handled or as nothing wrong. */
export async function resolveReportAction(_prev: AdminResult | null, formData: FormData): Promise<AdminResult> {
  const user = await requireUser('/app/admin');
  const parsed = z
    .object({ report_id: z.uuid(), outcome: z.enum(['actioned', 'dismissed']), note: z.string().trim().max(1000) })
    .safeParse({ report_id: formData.get('report_id'), outcome: formData.get('outcome'), note: formData.get('note') ?? '' });
  if (!parsed.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  const { error } = await supabaseAdmin().rpc('admin_resolve_abuse_report', { p_actor: user.id, p_report_id: parsed.data.report_id, p_status: parsed.data.outcome, p_note: parsed.data.note });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/admin');
  return { ok: true, message: parsed.data.outcome === 'actioned' ? 'Closed as handled.' : 'Closed: nothing wrong.' };
}

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
