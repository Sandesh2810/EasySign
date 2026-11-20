'use server';
// Team management (Phase 4 slice 1, D-75). Every action goes through a server-only database function that checks the
// person's role again (owner/admin manage; only the owner touches administrators; nobody changes the owner or themselves).
import { createHash, randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace, myWorkspaces, rememberWorkspace } from '@/lib/workspace';

export type TeamResult = { ok: true; message: string; link?: string } | { ok: false; message: string } | null;

const role = z.enum(['admin', 'member', 'viewer']);

export async function inviteAction(_prev: TeamResult, formData: FormData): Promise<TeamResult> {
  const user = await requireUser('/app/team');
  const parsed = z
    .object({ email: z.email('Type a full email address.').max(254), role })
    .safeParse({ email: String(formData.get('email') ?? '').trim(), role: formData.get('role') });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the address and the role.' };
  const { current } = await activeWorkspace(user.id);
  // The link carries a random secret; the database keeps only its SHA-256, so the link cannot be recovered later.
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const { error } = await supabaseAdmin().rpc('team_invite', {
    p_actor: user.id,
    p_org: current.orgId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_token_sha256: `\\x${hash}`,
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/team');
  return {
    ok: true,
    message: `Invitation ready for ${parsed.data.email.toLowerCase()}. Copy the link below and send it to them yourself; it works once, for that address only, for 7 days. It is shown only now.`,
    link: `${env.appUrl()}/join#${token}`,
  };
}

export async function withdrawInviteAction(_prev: TeamResult, formData: FormData): Promise<TeamResult> {
  const user = await requireUser('/app/team');
  const id = z.uuid().safeParse(formData.get('invitation_id'));
  if (!id.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const { error } = await supabaseAdmin().rpc('team_revoke_invite', { p_actor: user.id, p_invitation_id: id.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/team');
  return { ok: true, message: 'Invitation withdrawn. The link no longer works.' };
}

export async function setRoleAction(_prev: TeamResult, formData: FormData): Promise<TeamResult> {
  const user = await requireUser('/app/team');
  const parsed = z.object({ user_id: z.uuid(), role }).safeParse({ user_id: formData.get('user_id'), role: formData.get('role') });
  if (!parsed.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const { current } = await activeWorkspace(user.id);
  const { data, error } = await supabaseAdmin().rpc('team_set_role', { p_actor: user.id, p_org: current.orgId, p_user: parsed.data.user_id, p_role: parsed.data.role });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/team');
  return { ok: true, message: data ? 'Role changed.' : 'That was already their role.' };
}

export async function setActiveAction(_prev: TeamResult, formData: FormData): Promise<TeamResult> {
  const user = await requireUser('/app/team');
  const parsed = z.object({ user_id: z.uuid(), active: z.enum(['true', 'false']) }).safeParse({ user_id: formData.get('user_id'), active: formData.get('active') });
  if (!parsed.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  const { current } = await activeWorkspace(user.id);
  const active = parsed.data.active === 'true';
  const { error } = await supabaseAdmin().rpc('team_set_active', { p_actor: user.id, p_org: current.orgId, p_user: parsed.data.user_id, p_active: active });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/team');
  return {
    ok: true,
    message: active ? 'Reactivated. They can work in this workspace again.' : 'Deactivated. They can no longer open this workspace; their documents stay with the team.',
  };
}

/** Switch the workspace in use (only to one this person may use right now). */
export async function switchWorkspaceAction(formData: FormData) {
  const user = await requireUser('/app');
  const id = z.uuid().safeParse(formData.get('org_id'));
  if (id.success && (await myWorkspaces(user.id)).some((w) => w.orgId === id.data)) await rememberWorkspace(id.data);
  redirect('/app');
}
