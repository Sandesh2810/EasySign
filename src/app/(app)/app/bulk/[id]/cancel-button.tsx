'use client';
import { useState, useTransition } from 'react';
import { Button, Notice } from '@/components/ui';
import { cancelBulkAction, type BulkResult } from '../actions';

/** D-85: stop a bulk send. Rows not yet sent are cancelled; documents already sent are kept. */
export function CancelBulkButton({ batchId }: { batchId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [pending, start] = useTransition();
  if (!confirming) {
    return (
      <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
        Cancel the rest
      </Button>
    );
  }
  return (
    <div className="flex basis-full flex-col gap-2 rounded-md border border-hairline p-3">
      <p className="text-sm text-ink-body">Nothing more will be sent from this batch. Documents already sent are not affected (cancel them one by one if you need to).</p>
      {result && !result.ok ? <Notice tone="danger">{result.message}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => start(async () => setResult(await cancelBulkAction(batchId).catch(() => ({ ok: false as const, message: 'Could not reach the server.' }))))}>
          {pending ? 'Cancelling…' : 'Yes, cancel the rest'}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
          Keep sending
        </Button>
      </div>
    </div>
  );
}
