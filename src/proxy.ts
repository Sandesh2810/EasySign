// Next.js 16 "proxy" (formerly middleware). Two jobs, no authorisation decisions (every page and action checks
// the user itself with requireUser):
// 1. Every page gets a fresh nonce and the Content-Security-Policy in report-only mode (D-70). Next.js reads the
//    nonce from the request's Content-Security-Policy header and puts it on its own scripts.
// 2. On the account routes, keep the signed-in user's Supabase session fresh.
// Static files, the PDF viewer's files and API routes are not matched.
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { buildCsp, newNonce } from '@/lib/csp';
import { authCookieOptions } from '@/lib/supabase/cookie-options';

const SESSION_ROUTES = /^\/(app|login|signup|mfa|auth)(\/|$)/;

export async function proxy(request: NextRequest) {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const nonce = newNonce();
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === 'development', https: appUrl.startsWith('https://') });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp); // only for Next.js to find the nonce; not sent to the browser
  const forward = () => NextResponse.next({ request: { headers: requestHeaders } });
  let response = forward();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url && key && SESSION_ROUTES.test(request.nextUrl.pathname)) {
    const supabase = createServerClient(url, key, {
      cookieOptions: authCookieOptions(appUrl),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          requestHeaders.set('cookie', request.headers.get('cookie') ?? '');
          response = forward();
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
        },
      },
    });
    await supabase.auth.getClaims(); // verifies the token and refreshes it when it has expired
  }

  response.headers.set('Content-Security-Policy-Report-Only', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico|pdfjs/).*)',
      // prefetches do not render a page, so they need no nonce
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
