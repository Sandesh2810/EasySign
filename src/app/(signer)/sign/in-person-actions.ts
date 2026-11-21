'use server';
// D-86: actions on the in-person signing screen. The PIN is the host's; it is checked here against the session's
// hash and the outcome is recorded by the database (5 wrong PINs end the session). If a session ends because of wrong
// PINs, this browser is also signed out of the host's account, so nobody can walk into it from the signing screen.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { verifyPin } from '@/lib/in-person';
import { loadSignerContext, signerCookieName } from '@/lib/signing/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

type Result = { ok: true } | { ok: false; message: string };
const pinInput = z.string().max(20);

/** The screen's own lock: after a quiet spell, or when the signer chooses "Lock the screen". */
export async function lockInPersonAction(reason: 'inactive' | 'manual'): Promise<void> {
  const ctx = await loadSignerContext({ allowLocked: true });
  if (!ctx?.inPerson || ctx.inPerson.state !== 'active') return;
  await supabaseAdmin().rpc('in_person_lock', { p_token_id: ctx.tokenId, p_reason: reason === 'manual' ? 'manual' : 'inactive' });
}

/** Tells the server the screen is in use (loading the context does that), and says whether it still may be. */
export async function inPersonHeartbeatAction(): Promise<'active' | 'locked' | 'ended'> {
  const ctx = await loadSignerContext({ allowLocked: true, allowUnverified: true });
  return ctx?.inPerson?.state ?? 'ended';
}

async function checkPin(pin: string, action: 'unlock' | 'end'): Promise<{ state: string; ctxEnvelope: string | null } | { error: string }> {
  const parsed = pinInput.safeParse(pin);
  if (!parsed.success) return { error: 'Enter the PIN.' };
  const ctx = await loadSignerContext({ allowLocked: true, allowUnverified: true });
  if (!ctx?.inPerson) return { error: 'This in-person signing has ended.' };
  const admin = supabaseAdmin();
  const { data: s } = await admin.from('in_person_sessions').select('pin_hash').eq('id', ctx.inPerson.sessionId).maybeSingle();
  const ok = Boolean(s) && verifyPin(parsed.data, s!.pin_hash as string);
  const { data, error } = await admin.rpc('in_person_pin', { p_token_id: ctx.tokenId, p_ok: ok, p_action: action });
  if (error) return { error: 'Something went wrong. Try again.' };
  return { state: ok ? (data as string) : data === 'ended' ? 'locked_out' : 'wrong', ctxEnvelope: ctx.envelope.id };
}

/** Ends everything on this browser after too many wrong PINs: the signer session and the host's sign-in. */
async function lockOut(): Promise<never> {
  (await cookies()).delete(signerCookieName());
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === 'string' ? data.claims.sub : null;
  if (userId) await supabaseAdmin().rpc('in_person_end_for_host', { p_actor: userId });
  await supabase.auth.signOut();
  redirect('/login');
}

/** The host unlocks the screen so the signer can carry on. */
export async function unlockInPersonAction(pin: string): Promise<Result> {
  const r = await checkPin(pin, 'unlock');
  if ('error' in r) return { ok: false, message: r.error };
  if (r.state === 'locked_out') await lockOut();
  if (r.state === 'wrong') return { ok: false, message: 'That PIN is not right. After 5 wrong PINs the signing ends and you must sign in again.' };
  return { ok: true };
}

/** The host takes the device back: the session ends and the host returns to the document. */
export async function handBackAction(pin: string): Promise<Result> {
  const r = await checkPin(pin, 'end');
  if ('error' in r) return { ok: false, message: r.error };
  if (r.state === 'locked_out') await lockOut();
  if (r.state === 'wrong') return { ok: false, message: 'That PIN is not right. After 5 wrong PINs the signing ends and you must sign in again.' };
  (await cookies()).delete(signerCookieName());
  redirect(r.ctxEnvelope ? `/app/envelopes/${r.ctxEnvelope}` : '/app');
}
