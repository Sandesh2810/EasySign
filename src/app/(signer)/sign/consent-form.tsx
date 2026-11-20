'use client';
import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import { consentAction, type SignResult } from './actions';

export function ConsentForm({ signerName, paperRequested = false }: { signerName: string; paperRequested?: boolean }) {
  const [state, action, pending] = useActionState<SignResult | null, FormData>(consentAction, null);
  return (
    <form action={action} className="mt-6 flex flex-col gap-4 border-t border-hairline pt-6">
      <label className="flex items-start gap-3 text-base text-ink">
        <input type="checkbox" name="agree" required className="mt-1 size-5 shrink-0 accent-ink" />
        <span>I am {signerName}, and I agree to use electronic records and signatures for this document.</span>
      </label>
      {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'One moment…' : 'Agree and continue'}
        </Button>
      </div>
      {paperRequested ? null : <p className="text-sm text-ink-muted">Do not want to sign electronically? Use &quot;Ask for a paper copy&quot; below.</p>}
    </form>
  );
}
