'use server';
// D-90: API keys. Owners and administrators only (the database checks again). The key is returned once, here, and
// only its fingerprint is stored.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { API_SCOPES, newApiKey } from '@/lib/api/keys';
import { friendlyDbError } from '@/lib/db-error';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function createApiKeyAction(raw: { orgId: string; name: string; scopes: string[] }): Promise<{ ok: true; key: string } | { ok: false; message: string }> {
  const parsed = z.object({ orgId: z.uuid(), name: z.string().trim().min(1, 'Give the key a name.').max(80), scopes: z.array(z.enum(API_SCOPES)).min(1, 'Choose at least one permission.') }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the details.' };
  const user = await requireUser('/app/settings');
  const k = newApiKey();
  const { error } = await supabaseAdmin().rpc('create_api_key', { p_actor: user.id, p_org: parsed.data.orgId, p_name: parsed.data.name, p_scopes: parsed.data.scopes, p_prefix: k.prefix, p_key_sha256: k.sha256 });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/settings');
  return { ok: true, key: k.key };
}

export async function revokeApiKeyAction(keyId: string): Promise<{ ok: boolean; message: string }> {
  const id = z.uuid().safeParse(keyId);
  if (!id.success) return { ok: false, message: 'Key not found.' };
  const user = await requireUser('/app/settings');
  const { error } = await supabaseAdmin().rpc('revoke_api_key', { p_actor: user.id, p_key_id: id.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/settings');
  return { ok: true, message: 'Revoked. It stops working at once.' };
}
