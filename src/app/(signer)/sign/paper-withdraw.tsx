'use client';
// "Ask for a paper copy" and "Withdraw consent" (Phase 3, AT3.3). Both open a dialog; both tell the sender.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { requestPaperCopyAction, withdrawConsentAction, type SignResult } from './actions';

const OFFLINE = 'We could not reach the server. Nothing was changed. Try again.';

function useDialog() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);
  return { open, setOpen, ref };
}

const DIALOG = 'm-auto w-[min(36rem,calc(100vw-1.5rem))] rounded-lg bg-surface p-0 text-ink shadow-soft backdrop:bg-ink/60';
const AREA = 'rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink';

export function PaperCopyControl({ label = 'Ask for a paper copy', variant = 'quiet', className }: { label?: string; variant?: 'outline' | 'quiet'; className?: string }) {
  const { open, setOpen, ref } = useDialog();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignResult | null>(null);
  const router = useRouter();

  const send = async () => {
    if (busy) return;
    setBusy(true);
    const res = await requestPaperCopyAction(note).catch(() => ({ ok: false as const, message: OFFLINE }));
    setBusy(false);
    setResult(res);
    if (res.ok) router.refresh();
  };

  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => { setResult(null); setOpen(true); }}>
        {label}
      </Button>
      {open ? (
        <dialog ref={ref} onClose={() => setOpen(false)} aria-labelledby="paper-title" className={DIALOG}>
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <h2 id="paper-title" className="text-xl font-medium text-ink">Ask for a paper copy</h2>
            {result?.ok ? (
              <>
                <Notice tone="success">Done. The sender has been told and will decide how to get a paper copy to you.</Notice>
                <div className="flex justify-end">
                  <Button type="button" onClick={() => ref.current?.close()}>Close</Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-base text-ink-body">
                  The sender is told straight away and decides how to provide the paper copy. This does not stop you signing here; if you would rather not sign electronically at all, use &quot;Withdraw consent&quot; instead.
                </p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="paper-note" className="text-sm font-medium text-ink">Note for the sender (optional), for example where to send it</label>
                  <textarea id="paper-note" value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} className={AREA} />
                </div>
                {result && !result.ok ? <Notice tone="danger">{result.message}</Notice> : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => ref.current?.close()} disabled={busy}>Go back</Button>
                  <Button type="button" onClick={() => void send()} disabled={busy}>{busy ? 'Sending…' : 'Ask for a paper copy'}</Button>
                </div>
              </>
            )}
          </div>
        </dialog>
      ) : null}
    </>
  );
}

export function WithdrawControl({ className }: { className?: string }) {
  const { open, setOpen, ref } = useDialog();
  const [reason, setReason] = useState('');
  const [paper, setPaper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const withdraw = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await withdrawConsentAction(reason, paper).catch(() => ({ ok: false as const, message: OFFLINE }));
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    ref.current?.close();
    router.refresh();
  };

  return (
    <>
      <Button type="button" variant="quiet" className={className} onClick={() => setOpen(true)}>
        Withdraw consent
      </Button>
      {open ? (
        <dialog ref={ref} onClose={() => setOpen(false)} aria-labelledby="withdraw-title" className={DIALOG}>
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <h2 id="withdraw-title" className="text-xl font-medium text-ink">Withdraw your consent to sign electronically?</h2>
            <p className="text-base text-ink-body">
              Anything you have filled in or signed on this document is cleared, and you cannot sign until you agree again. The sender is told straight away. The document is not cancelled: the sender decides what happens next.
            </p>
            <label className="flex items-start gap-3 text-base text-ink">
              <input type="checkbox" checked={paper} onChange={(e) => setPaper(e.target.checked)} className="mt-1 size-5 shrink-0 accent-ink" />
              <span>Also ask the sender for a paper copy</span>
            </label>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="withdraw-reason" className="text-sm font-medium text-ink">Reason (optional; the sender will see it)</label>
              <textarea id="withdraw-reason" value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} className={AREA} />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => ref.current?.close()} disabled={busy}>Go back</Button>
              <Button type="button" onClick={() => void withdraw()} disabled={busy}>{busy ? 'Withdrawing…' : 'Withdraw consent'}</Button>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
