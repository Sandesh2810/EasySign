// Picks the storage backend. Supabase Storage is the default; the encrypted disk backend takes over
// for new files once Supabase usage passes 70% of the free allowance (wired up with check:budget).
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { SupabaseStorage } from './supabase';
import type { Backend, StorageAdapter } from './types';

let supabaseStore: SupabaseStorage | null = null;

/** Backend for new writes. */
export function getStorage(): StorageAdapter {
  if (!supabaseStore) supabaseStore = new SupabaseStorage(supabaseAdmin());
  return supabaseStore;
}

/** Backend that holds an existing object (each stored row records which one). */
export function getStorageFor(backend: Backend): StorageAdapter {
  if (backend === 'supabase') return getStorage();
  throw new Error('The disk storage backend is not enabled on this machine.');
}
