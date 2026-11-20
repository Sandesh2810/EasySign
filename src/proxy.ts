// Next.js 16 "proxy" (formerly middleware). Its only job here is to keep the signed-in user's
// Supabase session fresh on the routes that use it. It makes no authorisation decisions:
// every page and action checks the user itself (requireUser).
// Signer routes (/s, /sign), /verify and static files are deliberately not matched.
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });
  await supabase.auth.getClaims(); // verifies the token and refreshes it when it has expired
  return response;
}

export const config = {
  matcher: ['/app/:path*', '/login', '/signup', '/mfa', '/auth/:path*'],
};
