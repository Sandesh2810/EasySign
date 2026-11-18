'use client';
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { setApprovalAction, type AdminResult } from './actions';

export function ApprovalForm({ userId, approved, who, disabled }: { userId: string; approved: boolean; who: string; disabled?: string }) {
  const [state, action, pending] = useActionState<AdminResult | null, FormData>(setApprovalAction, null);
  if (disabled) return <span className="text-sm text-ink-muted">{disabled}</span>;
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="approve" value={approved ? '0' : '1'} />
      <Button type="submit" variant={approved ? 'outline' : 'primary'} className="min-h-10 px-4 text-sm" disabled={pending} aria-label={`${approved ? 'Remove approval from' : 'Approve'} ${who}`}>
        {pending ? 'Saving…' : approved ? 'Remove approval' : 'Approve'}
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-sm text-ink">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
