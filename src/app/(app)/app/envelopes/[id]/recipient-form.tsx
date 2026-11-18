'use client';
import { useActionState } from 'react';
import { Button, Notice, TextField } from '@/components/ui';
import { saveRecipientAction, type ActionResult } from '../actions';

export function RecipientForm({ envelopeId, recipient }: { envelopeId: string; recipient: { name: string; email: string } | null }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveRecipientAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <TextField id="signer-name" name="name" label="Signer's name" defaultValue={recipient?.name ?? ''} autoComplete="off" maxLength={120} />
      <TextField id="signer-email" name="email" type="email" label="Signer's email" defaultValue={recipient?.email ?? ''} autoComplete="off" />
      {state ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : recipient ? 'Update signer' : 'Save signer'}
        </Button>
        <Button type="submit" name="self" value="1" variant="outline" disabled={pending} formNoValidate>
          I will sign it myself
        </Button>
      </div>
    </form>
  );
}
