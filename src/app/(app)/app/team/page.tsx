import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace, canManageTeam, ROLE_LABEL, type Role } from '@/lib/workspace';
import { ActiveForm, InviteForm, RoleForm, WithdrawForm } from './team-forms';

export const metadata: Metadata = { title: 'Team' };

type Member = { user_id: string; display_name: string; email: string; role: Role; active: boolean; joined_at: string };
type Invitation = { id: string; email: string; role: Role; created_at: string; expires_at: string };

export default function TeamPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="text-2xl font-medium text-ink">Team</h1>
      <Suspense fallback={<p className="text-ink-muted">Loading the team…</p>}>
        <Team />
      </Suspense>
    </div>
  );
}

async function Team() {
  const user = await requireUser('/app/team');
  const { current: ws } = await activeWorkspace(user.id);
  const manager = canManageTeam(ws.role);
  const owner = ws.role === 'owner';
  const admin = supabaseAdmin();
  const [members, invitations] = await Promise.all([
    admin.rpc('team_members', { p_actor: user.id, p_org: ws.orgId }),
    manager ? admin.rpc('team_open_invitations', { p_actor: user.id, p_org: ws.orgId }) : Promise.resolve({ data: [], error: null }),
  ]);
  const list = (members.data ?? []) as Member[];
  const open = (invitations.data ?? []) as Invitation[];
  // What the person may change about someone; the database enforces the same rules.
  const mayManage = (m: Member) => manager && m.user_id !== user.id && m.role !== 'owner' && (m.role !== 'admin' || owner);

  return (
    <>
      <p className="text-base text-ink-body">
        {ws.name} · you are {ws.role === 'admin' ? 'an' : 'a'} {ROLE_LABEL[ws.role].toLowerCase()}. Members see only the documents they sent; the owner,
        administrators and viewers see every document in this workspace.
      </p>

      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="members-heading">
        <h2 id="members-heading" className="mb-4 text-base font-medium text-ink">
          People ({list.filter((m) => m.active).length} active)
        </h2>
        {members.error ? (
          <p role="alert" className="text-sm text-ink">
            The team could not be loaded. Reload the page.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-base text-ink [overflow-wrap:anywhere]">
                    {m.display_name || m.email}
                    {m.user_id === user.id ? <span className="text-ink-muted"> (you)</span> : null}
                  </p>
                  <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
                    {m.email} · {ROLE_LABEL[m.role]}
                    {m.active ? '' : ' · deactivated'}
                  </p>
                </div>
                {mayManage(m) ? (
                  <div className="flex flex-wrap items-center gap-3">
                    {m.active ? <RoleForm userId={m.user_id} name={m.display_name || m.email} role={m.role} canMakeAdmin={owner} /> : null}
                    <ActiveForm userId={m.user_id} name={m.display_name || m.email} active={m.active} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {manager ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="mb-1 text-base font-medium text-ink">
            Invite someone
          </h2>
          <p className="mb-4 text-sm text-ink-muted">
            You get a link to send them yourself. They open it, sign in or create an account with that same address, and join. Up to 25 people per team, counting open
            invitations.
          </p>
          <InviteForm canInviteAdmin={owner} />
        </section>
      ) : null}

      {manager && open.length ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="open-heading">
          <h2 id="open-heading" className="mb-4 text-base font-medium text-ink">
            Open invitations
          </h2>
          <ul className="divide-y divide-hairline">
            {open.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <p className="text-sm text-ink [overflow-wrap:anywhere]">
                  {i.email} · {ROLE_LABEL[i.role]} · link works until {i.expires_at.slice(0, 10)}
                </p>
                {i.role !== 'admin' || owner ? <WithdrawForm invitationId={i.id} email={i.email} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
