// Reads the platform's usage numbers from the database (server only). Returns null when they cannot be
// read: callers treat that as "not full", because this is a courtesy limit, not a security check.
import 'server-only';
import type { PlatformUsage } from '@/lib/free-tier';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function loadPlatformUsage(): Promise<PlatformUsage | null> {
  try {
    const { data, error } = await supabaseAdmin().rpc('platform_usage');
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) return null;
    return {
      dbBytes: Number(row.db_bytes),
      storageBytes: Number(row.storage_bytes),
      userCount: Number(row.user_count),
      emailsToday: Number(row.emails_today),
      emailsMonth: Number(row.emails_month),
    };
  } catch {
    return null;
  }
}
