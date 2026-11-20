'use client';
import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import { setRetentionAction, type RetentionResult } from '../envelopes/retention-actions';

export function RetentionForm({ orgId, years, owner }: { orgId: string; years: number; owner: boolean }) {
  const [state, action, pending] = useActionState<RetentionResult | null, FormData>(setRetentionAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="org_id" value={orgId} />
      <label htmlFor="years" className="text-base font-medium text-ink">Keep finished documents for</label>
      <select id="years" name="years" defaultValue={String(years)} disabled={!owner} className="min-h-11 w-48 rounded-sm border border-control-border bg-surface px-3 text-base text-ink">
        {[0, 1, 2, 3, 5, 7, 10, 15, 20, 30].map((y) => (
          <option key={y} value={y}>
            {y === 0 ? 'No minimum' : `${y} ${y === 1 ? 'year' : 'years'}`}
          </option>
        ))}
      </select>
      <p className="text-sm text-ink-muted">
        A finished document cannot be deleted before this period ends, counted from the day it was finished. Nothing is ever deleted automatically: after the
        period, only the owner can delete a document, one at a time. Changing this needs a code from your authenticator app.
      </p>
      {owner ? (
        <div>
          <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Only the workspace owner can change this.</p>
      )}
      {state ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
    </form>
  );
}
