// Service client: uses the SECRET key and bypasses row-level security. Server-only.
// Rules (DECISIONS D-35): import this only from server actions, route handlers and the worker;
// always establish who the acting user is with requireUser() first and pass that id explicitly.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

let client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl(), env.supabaseSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}
