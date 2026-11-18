// Who is making this request? The single place server code asks that question (DECISIONS D-35).
import 'server-only';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface SessionUser {
  id: string;
  email: string | null;
}

/** The verified signed-in user, or null. Uses getClaims(), which validates the token's signature. */
export async function getUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (error || typeof sub !== 'string' || !sub) return null;
  const email = typeof data.claims.email === 'string' ? data.claims.email : null;
  return { id: sub, email };
}

/** Use at the top of every server action and protected page. Sends visitors to the login page. */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  return user;
}
