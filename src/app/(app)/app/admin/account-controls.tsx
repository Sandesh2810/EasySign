'use client';
// Administrator controls for one account (suspend or lift, daily limits, trusted) and for one abuse report.
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { adminResetMfaAction, type MfaResult } from '@/lib/auth/mfa-actions';
import { resolveReportAction, setLimitsAction, setSuspensionAction, type AdminResult } from './actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const Said = ({ state }: { state: AdminResult | null }) =>
  state ? (
    <span role={state.ok ? 'status' : 'alert'} className="text-sm text-ink">
      {state.message}
    </span>
  ) : null;

export function SuspendForm({ userId, who, suspended }: { userId: string; who: string; suspended: boolean }) {
  const [state, action, pending] = useActionState<AdminResult | null, FormData>(setSuspensionAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="suspend" value={suspended ? '0' : '1'} />
      {suspended ? null : (
        <>
          <label htmlFor={`reason-${userId}`} className="text-sm font-medium text-ink">
            Reason for suspending (for administrators only, optional)
          </label>
          <input id={`reason-${userId}`} name="reason" maxLength={500} autoComplete="off" className={INPUT} />
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" name="confirm" className="mt-0.5 size-5 shrink-0 accent-ink" />
            <span>Suspend {who}. Their open documents go on hold and they cannot send new ones.</span>
          </label>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending}>
          {pending ? 'Saving…' : suspended ? 'Lift the suspension' : 'Suspend this account'}
        </Button>
        <Said state={state} />
      </div>
    </form>
  );
}

export function LimitsForm({ userId, documents, people, trusted }: { userId: string; documents: number; people: number; trusted: boolean }) {
  const [state, action, pending] = useActionState<AdminResult | null, FormData>(setLimitsAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="user_id" value={userId} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`docs-${userId}`} className="text-sm font-medium text-ink">
            Documents per day
          </label>
          <input id={`docs-${userId}`} name="documents" type="number" min={0} max={500} defaultValue={documents} required className={`${INPUT} w-28`} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`people-${userId}`} className="text-sm font-medium text-ink">
            New people per day
          </label>
          <input id={`people-${userId}`} name="people" type="number" min={0} max={2000} defaultValue={people} required className={`${INPUT} w-28`} />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="trusted" defaultChecked={trusted} className="size-5 shrink-0 accent-ink" />
          <span>Trusted (not held to the small shared email allowance for new accounts)</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save limits'}
        </Button>
        <Said state={state} />
      </div>
    </form>
  );
}

export function ReportForm({ reportId }: { reportId: string }) {
  const [state, action, pending] = useActionState<AdminResult | null, FormData>(resolveReportAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="report_id" value={reportId} />
      <label htmlFor={`note-${reportId}`} className="text-sm font-medium text-ink">
        Your note (optional)
      </label>
      <input id={`note-${reportId}`} name="note" maxLength={1000} autoComplete="off" className={INPUT} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" name="outcome" value="actioned" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending}>
          Close: handled
        </Button>
        <Button type="submit" name="outcome" value="dismissed" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending}>
          Close: nothing wrong
        </Button>
        <Said state={state} />
      </div>
    </form>
  );
}

/** Removes someone else's authenticator (lost phone and lost recovery codes). Check who is asking first. */
export function ResetMfaForm({ userId, who }: { userId: string; who: string }) {
  const [state, action, pending] = useActionState<MfaResult | null, FormData>(adminResetMfaAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="user_id" value={userId} />
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" name="confirm" className="mt-0.5 size-5 shrink-0 accent-ink" />
        <span>I have checked that {who} really is asking. Remove their two-step sign-in so they can set it up again.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending}>
          {pending ? 'Removing…' : 'Reset two-step sign-in'}
        </Button>
        {state ? <span role={state.ok ? 'status' : 'alert'} className="text-sm text-ink">{state.message}</span> : null}
      </div>
    </form>
  );
}
