// Which workspace a signed-in person is working in (Phase 4 slice 1, D-75).
// Everyone has their own workspace (they own it) and may be in other people's teams. The one in use is remembered in
// a cookie, but the cookie only ever SELECTS among the workspaces the database says this person may use right now
// (public.my_workspaces: active memberships only), so a forged or stale cookie falls back to their own workspace.
import 'server-only';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { env } from '@/lib/env';

export const WORKSPACE_COOKIE = 'ynms_workspace';
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export interface Workspace {
  orgId: string;
  name: string;
  role: Role;
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Administrator', member: 'Member', viewer: 'Viewer' };
export const canSend = (role: Role) => role !== 'viewer';
export const canManageTeam = (role: Role) => role === 'owner' || role === 'admin';
export const seesAllDocuments = (role: Role) => role !== 'member';

export async function myWorkspaces(userId: string): Promise<Workspace[]> {
  const { data, error } = await supabaseAdmin().rpc('my_workspaces', { p_actor: userId });
  if (error) throw new Error('Could not load your workspaces.');
  return ((data ?? []) as { org_id: string; name: string; role: Role }[]).map((w) => ({ orgId: w.org_id, name: w.name, role: w.role }));
}

/** The workspace in use and all the person's workspaces. Throws only if the person has none (should not happen). */
export async function activeWorkspace(userId: string): Promise<{ current: Workspace; all: Workspace[] }> {
  const all = await myWorkspaces(userId);
  if (!all.length) throw new Error('No workspace found for this account.');
  const wanted = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = all.find((w) => w.orgId === wanted) ?? all[0];
  return { current, all };
}

/** Remember the workspace in use (call only with an id taken from myWorkspaces). */
export async function rememberWorkspace(orgId: string) {
  (await cookies()).set(WORKSPACE_COOKIE, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.appUrl().startsWith('https://'),
    path: '/',
    maxAge: 60 * 60 * 24 * 180,
  });
}
