// OAuth return address for "Continue with Google / Microsoft". Exchanges the one-time code for a session.
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { safeNext } from '@/lib/safe-redirect';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get('code');
  const base = env.appUrl();
  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(safeNext(params.get('next')), base));
  }
  return NextResponse.redirect(new URL('/login?error=oauth', base));
}
