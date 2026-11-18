// Supabase Storage backend. Uses the service client: buckets are private and have no client policies,
// so only the server can reach them. Originals are additionally protected by a database trigger
// (insert-only), so even this code cannot overwrite one.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkPath, StorageError, type Bucket, type StorageAdapter } from './types';

export class SupabaseStorage implements StorageAdapter {
  readonly backend = 'supabase' as const;
  constructor(private readonly client: SupabaseClient) {}

  async put(bucket: Bucket, path: string, data: Uint8Array, opts: { contentType: string }): Promise<void> {
    checkPath(bucket, path);
    const { error } = await this.client.storage.from(bucket).upload(path, data, { contentType: opts.contentType, upsert: false });
    if (!error) return;
    if (/exist|duplicate/i.test(error.message)) throw new StorageError('ALREADY_EXISTS', 'A file already exists at this path');
    throw new StorageError('BACKEND', 'Could not write to storage');
  }

  async get(bucket: Bucket, path: string): Promise<Uint8Array> {
    checkPath(bucket, path);
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (error || !data) {
      if (error && /not.?found|does not exist|404/i.test(error.message)) throw new StorageError('NOT_FOUND', 'File not found in storage');
      throw new StorageError('BACKEND', 'Could not read from storage');
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async exists(bucket: Bucket, path: string): Promise<boolean> {
    const parts = checkPath(bucket, path);
    const { data, error } = await this.client.storage.from(bucket).list(parts.slice(0, 2).join('/'), { search: parts[2], limit: 5 });
    if (error) throw new StorageError('BACKEND', 'Could not read from storage');
    return (data ?? []).some((o) => o.name === parts[2]);
  }

  async remove(bucket: Bucket, path: string, opts: { draftOnly?: boolean } = {}): Promise<void> {
    checkPath(bucket, path);
    if (bucket === 'originals' && !opts.draftOnly) throw new StorageError('IMMUTABLE', 'Original documents cannot be deleted');
    const { error } = await this.client.storage.from(bucket).remove([path]);
    if (error) throw new StorageError(/cannot be deleted/i.test(error.message) ? 'IMMUTABLE' : 'BACKEND', 'Could not delete from storage');
  }

  async usageBytes(): Promise<number> {
    const { data, error } = await this.client.rpc('storage_usage_bytes');
    if (error) throw new StorageError('BACKEND', 'Could not read storage usage');
    return Number(data ?? 0);
  }
}
