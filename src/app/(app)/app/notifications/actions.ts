'use server';
// Notifications page actions. Marking notices as read goes through the person's own session
// (row-level security allows a person to set read_at on their own notices and nothing else).
// The daily-summary choice goes through a server-only database function (DECISIONS D-35).
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type NoticeResult = { ok: true; message: string } | { ok: false; message: string };

export async function markAllReadAction(): Promise<void> {
  const user = await requireUser('/app/notifications');
  const supabase = await createSupabaseServerClient();
  await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', user.id).is('read_at', null);
  revalidatePath('/app', 'layout');
}

export async function setDigestAction(_prev: NoticeResult | null, formData: FormData): Promise<NoticeResult> {
  const user = await requireUser('/app/notifications');
  const on = formData.get('digest') === '1';
  const { error } = await supabaseAdmin().rpc('set_digest_opt_in', { p_actor: user.id, p_on: on });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/notifications');
  return {
    ok: true,
    message: on ? 'Switched on. Your first summary covers what happens from now on and arrives in about a day, if there is anything to report.' : 'Switched off. No more summary emails.',
  };
}
