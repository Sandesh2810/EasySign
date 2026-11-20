'use client';
// Keeping and deleting a finished document (Phase 3 slice 6, AT3.6): legal hold and deletion.
import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import { deleteEnvelopeAction, setLegalHoldAction, type RetentionResult } from '../retention-actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const Said = ({ state }: { state: RetentionResult | null }) => (state ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null);

export function LegalHoldForm({ envelopeId, on }: { envelopeId: string; on: boolean }) {
  const [state, action, pending] = useActionState<RetentionResult | null, FormData>(setLegalHoldAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <input type="hidden" name="on" value={on ? '0' : '1'} />
      {on ? null : (
        <>
          <label htmlFor="hold-reason" className="text-sm font-medium text-ink">Reason for the legal hold (kept with the document, not in the audit trail)</label>
          <input id="hold-reason" name="reason" maxLength={500} required autoComplete="off" className={INPUT} />
        </>
      )}
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : on ? 'Release the legal hold' : 'Put on legal hold'}
        </Button>
      </div>
      <Said state={state} />
    </form>
  );
}

export function DeleteForm({ envelopeId, code }: { envelopeId: string; code: string }) {
  const [state, action, pending] = useActionState<RetentionResult | null, FormData>(deleteEnvelopeAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <p className="text-sm text-ink-body">
        Deleting removes the file, the signed copy, the certificate, what people typed, their signatures, their names and email addresses, and the title.
        What stays: the document&apos;s fingerprints and its history, with a record that you deleted it. This cannot be undone. You will be asked for a code
        from your authenticator app.
      </p>
      <label htmlFor="confirm-code" className="text-sm font-medium text-ink">
        To confirm, type this document&apos;s verification code: <span className="font-mono">{code}</span>
      </label>
      <input id="confirm-code" name="confirm_code" required autoComplete="off" spellCheck={false} className={`${INPUT} font-mono`} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Deleting…' : 'Delete this document permanently'}
        </Button>
      </div>
      <Said state={state} />
    </form>
  );
}
