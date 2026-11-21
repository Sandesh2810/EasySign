// Who is making this request? The single place server code asks that question (DECISIONS D-35).
import 'server-only';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mfaGate } from './mfa-policy';
import { IN_PERSON_HOST_PAGE, openInPersonSessions } from '@/lib/in-person-host';

export interface SessionUser {
  id: string;
  email: string | null;
  /** "aal1" after a password, "aal2" after an authenticator code (Supabase Auth). */
  aal: string;
  /** How and when this session was proved: [{ method, timestamp }], newest first. */
  amr: unknown;
}

/** The verified signed-in user, or null. Uses getClaims(), which validates the token's signature. */
export async function getUser(): Promise<SessionUser | null> {
  // Signed-in data is always produced for a real request, never prerendered or prefetched ahead of
  // a click: token checks depend on the current time and on this visitor's cookies.
  await connection();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (error || typeof sub !== 'string' || !sub) return null;
  const email = typeof data.claims.email === 'string' ? data.claims.email : null;
  const aal = typeof data.claims.aal === 'string' ? data.claims.aal : 'aal1';
  return { id: sub, email, aal, amr: (data.claims as { amr?: unknown }).amr ?? null };
}

export interface MfaStatus {
  enrolled: boolean;
  codesLeft: number;
  admin: boolean;
}

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const { data, error } = await supabaseAdmin().rpc('mfa_status', { p_actor: userId });
  if (error || !data) throw new Error('two-step sign-in status unavailable');
  const d = data as { enrolled?: boolean; codes_left?: number; admin?: boolean };
  return { enrolled: d.enrolled === true, codesLeft: Number(d.codes_left ?? 0), admin: d.admin === true };
}

const codePage = (next: string, fresh = false) => `/mfa?next=${encodeURIComponent(next)}${fresh ? '&fresh=1' : ''}`;

/**
 * Use at the top of every server action and protected page. Sends visitors to the login page, and anyone
 * who has switched on two-step sign-in but has not entered a code in this session to the code page (D-69).
 */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  if (user.aal !== 'aal2') {
    // Only sessions without a code need the lookup; one with a code has passed already.
    const status = await mfaStatus(user.id);
    if (mfaGate({ aal: user.aal, amr: user.amr, hasFactor: status.enrolled, admin: false, nowSeconds: Date.now() / 1000 }) === 'verify') {
      redirect(codePage(next ?? '/app'));
    }
  }
  // D-86: this person's device is with an in-person signer; their account opens only with the PIN
  if ((await openInPersonSessions(user.id)).length) redirect(IN_PERSON_HOST_PAGE);
  return user;
}

/**
 * The admin pages and every admin action: the platform admin must have an authenticator, must have used it
 * in this session, and within the last 12 hours (D-69). Others get "not found", as before.
 */
export async function requireAdminMfa(next = '/app/admin'): Promise<SessionUser> {
  const user = await requireUser(next);
  const status = await mfaStatus(user.id);
  if (!status.admin) return user; // the database refuses non-admins on every admin function
  const gate = mfaGate({ aal: user.aal, amr: user.amr, hasFactor: status.enrolled, admin: true, nowSeconds: Date.now() / 1000 });
  if (gate === 'enroll') redirect('/app/account/security?required=admin');
  if (gate === 'verify') redirect(codePage(next));
  if (gate === 'reverify') redirect(codePage(next, true));
  return user;
}
