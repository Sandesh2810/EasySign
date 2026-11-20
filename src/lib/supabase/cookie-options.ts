// How the account session cookie is set (Phase 3 slice 5, carried D-50, D-70). Pure: shared by proxy.ts and the
// server client so both use the same name. On https the name carries the "__Host-" prefix: browsers then accept
// it only from this exact host, over https, for the whole site and with no Domain attribute, so no other site
// (even a sub-domain) can plant or overwrite it. Browsers refuse such cookies on plain http, so local
// development keeps Supabase's default name. httpOnly: no page script ever needs to read it (there is no
// Supabase client in the browser).
export function authCookieOptions(appUrl: string) {
  const https = appUrl.startsWith('https://');
  return {
    ...(https ? { name: '__Host-ys-auth' } : {}),
    path: '/',
    sameSite: 'lax' as const,
    secure: https,
    httpOnly: true,
  };
}
