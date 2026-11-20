'use client';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import { inviteAction, setActiveAction, setRoleAction, withdrawInviteAction, type TeamResult } from './actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const Said = ({ state }: { state: TeamResult }) =>
  state ? (
    <span role={state.ok ? 'status' : 'alert'} className="text-sm text-ink">
      {state.message}
    </span>
  ) : null;

const ROLE_HELP: Record<string, string> = {
  admin: 'Administrator: sees and handles every document, invites and manages members and viewers',
  member: 'Member: sends documents; sees only the documents they sent',
  viewer: 'Viewer: reads every document, changes nothing',
};

export function InviteForm({ canInviteAdmin }: { canInviteAdmin: boolean }) {
  const [state, action, pending] = useActionState<TeamResult, FormData>(inviteAction, null);
  const [copied, setCopied] = useState(false);
  const link = state && state.ok ? state.link : undefined;
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-auto">
          <label htmlFor="invite-email" className="text-sm font-medium text-ink">
            Email address
          </label>
          <input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" className={`${INPUT} w-full sm:w-72`} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invite-role" className="text-sm font-medium text-ink">
            Role
          </label>
          <select id="invite-role" name="role" defaultValue="member" className={INPUT}>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
            {canInviteAdmin ? <option value="admin">Administrator</option> : null}
          </select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Preparing…' : 'Create invitation'}
        </Button>
      </form>
      <Said state={state} />
      {link ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="invite-link" className="sr-only">
            Invitation link
          </label>
          <input id="invite-link" readOnly value={link} className={`${INPUT} min-w-0 flex-1 font-mono text-sm`} onFocus={(e) => e.currentTarget.select()} />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      ) : null}
      <ul className="text-sm text-ink-muted">
        {['member', 'viewer', ...(canInviteAdmin ? ['admin'] : [])].map((r) => (
          <li key={r}>{ROLE_HELP[r]}</li>
        ))}
      </ul>
    </div>
  );
}

export function RoleForm({ userId, name, role, canMakeAdmin }: { userId: string; name: string; role: string; canMakeAdmin: boolean }) {
  const [state, action, pending] = useActionState<TeamResult, FormData>(setRoleAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="user_id" value={userId} />
      <label htmlFor={`role-${userId}`} className="sr-only">
        Role for {name}
      </label>
      <select id={`role-${userId}`} name="role" defaultValue={role} className={`${INPUT} min-h-10 text-sm`}>
        <option value="member">Member</option>
        <option value="viewer">Viewer</option>
        {canMakeAdmin || role === 'admin' ? <option value="admin">Administrator</option> : null}
      </select>
      <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending} aria-label={`Change role: ${name}`}>
        Change role
      </Button>
      <Said state={state} />
    </form>
  );
}

export function ActiveForm({ userId, name, active }: { userId: string; name: string; active: boolean }) {
  const [state, action, pending] = useActionState<TeamResult, FormData>(setActiveAction, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (active && !window.confirm(`Deactivate ${name}? They lose access to this workspace at once. Their documents stay with the team.`)) e.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="active" value={active ? 'false' : 'true'} />
      <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending} aria-label={`${active ? 'Deactivate' : 'Reactivate'}: ${name}`}>
        {active ? 'Deactivate' : 'Reactivate'}
      </Button>
      <Said state={state} />
    </form>
  );
}

export function WithdrawForm({ invitationId, email }: { invitationId: string; email: string }) {
  const [state, action, pending] = useActionState<TeamResult, FormData>(withdrawInviteAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="invitation_id" value={invitationId} />
      <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending} aria-label={`Withdraw: ${email}`}>
        Withdraw
      </Button>
      <Said state={state} />
    </form>
  );
}
