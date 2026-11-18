// Supabase client for the signed-in user on the server (Server Components, Server Actions, Route Handlers).
// It carries the user's session cookies, so every query is subject to row-level security.
import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { env } from '@/lib/env';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabasePublishableKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies. Sessions are refreshed in src/proxy.ts instead.
        }
      },
    },
  });
}
