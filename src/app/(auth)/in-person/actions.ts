'use server';
// D-86: the host returns to their account from /in-person with their PIN. The session ends (its link stops working).
// After 5 wrong PINs the session ends and this browser is signed out, so the account opens only with a full sign-in.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getUser } from '@/lib/auth/session';
import { verifyPin } from '@/lib/in-person';
import { openInPersonSessions } from '@/lib/in-person-host';
import { signerCookieName } from '@/lib/signing/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function returnToAccountAction(sessionId: string, pin: string): Promise<{ ok: false; message: string }> {
  const parsed = z.object({ sessionId: z.uuid(), pin: z.string().max(20) }).safeParse({ sessionId, pin });
  if (!parsed.success) return { ok: false, message: 'Enter your PIN.' };
  const user = await getUser();
  if (!user) redirect('/login');
  const s = (await openInPersonSessions(user.id)).find((x) => x.session_id === parsed.data.sessionId);
  if (!s) redirect('/app');
  const ok = verifyPin(parsed.data.pin, s.pin_hash);
  const { data, error } = await supabaseAdmin().rpc('in_person_host_end', { p_actor: user.id, p_session_id: s.session_id, p_ok: ok });
  if (error) return { ok: false, message: 'Something went wrong. Try again.' };
  if (ok) {
    (await cookies()).delete(signerCookieName()); // the signer session on this device ends with it
    redirect(`/app/envelopes/${s.envelope_id}`);
  }
  if (data === 'ended') {
    (await cookies()).delete(signerCookieName());
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    redirect('/login');
  }
  return { ok: false, message: 'That PIN is not right. After 5 wrong PINs the in-person signing ends and you must sign in again.' };
}
