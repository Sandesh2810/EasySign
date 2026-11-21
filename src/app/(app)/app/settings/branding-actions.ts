'use server';
// D-88 (AT4.8): workspace branding. Owners and administrators only (the database checks that again, and the contrast).
import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { brandProblem, cleanFooter, logoType, MAX_LOGO_BYTES, normaliseColor } from '@/lib/branding';
import { friendlyDbError } from '@/lib/db-error';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';

type Result = { ok: true; message: string } | { ok: false; message: string };
const store = () => getStorageFor('supabase');
const removeFile = async (path: string | null | undefined) => {
  if (path) await store().remove('branding', path).catch(() => undefined);
};

export async function saveBrandingAction(raw: { orgId: string; color: string; text: 'light' | 'dark'; footer: string }): Promise<Result> {
  const parsed = z.object({ orgId: z.uuid(), color: z.string().max(20), text: z.enum(['light', 'dark']), footer: z.string().max(2000) }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'Check the branding details.' };
  const user = await requireUser('/app/settings');
  const problem = brandProblem(parsed.data.color, parsed.data.text);
  if (problem) return { ok: false, message: problem };
  const footer = cleanFooter(parsed.data.footer);
  const { error } = await supabaseAdmin().rpc('set_org_branding', {
    p_actor: user.id,
    p_org: parsed.data.orgId,
    p_color: normaliseColor(parsed.data.color),
    p_text: parsed.data.text,
    p_footer: footer || null,
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/settings');
  return { ok: true, message: 'Saved. New signing pages and emails for this workspace use it.' };
}

export async function uploadLogoAction(form: FormData): Promise<Result> {
  const orgId = z.uuid().safeParse(form.get('orgId'));
  const file = form.get('logo');
  if (!orgId.success || !(file instanceof File)) return { ok: false, message: 'Choose a logo file.' };
  const user = await requireUser('/app/settings');
  // D-89: nothing is written to storage for a workspace this person does not run (the database checks again)
  const { data: role } = await supabaseAdmin().from('memberships').select('role').eq('org_id', orgId.data).eq('user_id', user.id).is('deactivated_at', null).maybeSingle();
  if (role?.role !== 'owner' && role?.role !== 'admin') return { ok: false, message: 'Only the workspace’s owner or an administrator can change its branding.' };
  if (file.size === 0 || file.size > MAX_LOGO_BYTES) return { ok: false, message: 'The logo must be a PNG or JPEG file of up to 200 KB.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = logoType(bytes);
  if (!type) return { ok: false, message: 'The logo must be a PNG or JPEG file (other kinds, such as SVG, are not accepted).' };
  const path = `${orgId.data}/logo/${randomUUID()}.${type === 'image/png' ? 'png' : 'jpg'}`;
  try {
    await store().put('branding', path, bytes, { contentType: type });
  } catch {
    return { ok: false, message: 'The logo could not be stored. Try again.' };
  }
  const { data: old, error } = await supabaseAdmin().rpc('set_org_logo', {
    p_actor: user.id,
    p_org: orgId.data,
    p_path: path,
    p_sha256: createHash('sha256').update(bytes).digest('hex'),
    p_type: type,
  });
  if (error) {
    await removeFile(path);
    return { ok: false, message: friendlyDbError(error.message).message };
  }
  await removeFile(old as string | null);
  revalidatePath('/app/settings');
  return { ok: true, message: 'Logo saved.' };
}

export async function removeLogoAction(orgId: string): Promise<Result> {
  const id = z.uuid().safeParse(orgId);
  if (!id.success) return { ok: false, message: 'Workspace not found.' };
  const user = await requireUser('/app/settings');
  const { data: old, error } = await supabaseAdmin().rpc('set_org_logo', { p_actor: user.id, p_org: id.data, p_path: null, p_sha256: null, p_type: null });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  await removeFile(old as string | null);
  revalidatePath('/app/settings');
  return { ok: true, message: 'Logo removed.' };
}

export async function clearBrandingAction(orgId: string): Promise<Result> {
  const id = z.uuid().safeParse(orgId);
  if (!id.success) return { ok: false, message: 'Workspace not found.' };
  const user = await requireUser('/app/settings');
  const { data: old, error } = await supabaseAdmin().rpc('clear_org_branding', { p_actor: user.id, p_org: id.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  await removeFile(old as string | null);
  revalidatePath('/app/settings');
  return { ok: true, message: 'Branding switched off. Signing pages and emails use the plain look again.' };
}
