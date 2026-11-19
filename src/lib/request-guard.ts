// Checks shared by API route handlers: same-origin (CSRF defence in depth) and a signed-in user.
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { getUser, type SessionUser } from '@/lib/auth/session';

export const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** A state-changing request must come from our own pages. Browsers always send Origin on POST. */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env.appUrl()).origin;
  } catch {
    return false;
  }
}

export async function requireApiUser(request: NextRequest, opts: { mutation: boolean }): Promise<{ user: SessionUser } | { response: NextResponse }> {
  if (opts.mutation && !isSameOrigin(request)) return { response: json(403, { error: 'This request did not come from YouNMeSign.' }) };
  const user = await getUser();
  if (!user) return { response: json(401, { error: 'Your session has ended. Sign in again.' }) };
  return { user };
}

/** Database functions raise messages that start with a code such as "ES_QUOTA: ...". */
export function friendlyDbError(message: string | undefined): { code: string; message: string } {
  const m = /^(ES_[A-Z_]+):\s*(.*)$/.exec(message ?? '');
  if (m) return { code: m[1], message: m[2].charAt(0).toUpperCase() + m[2].slice(1) + '.' };
  return { code: 'ES_ERROR', message: 'Something went wrong. Nothing was changed. Try again.' };
}
