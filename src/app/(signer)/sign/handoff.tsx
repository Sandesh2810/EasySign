'use client';
// "Hand to someone else" (D-83, AT4.6): shown only when the sender allowed it for this document, to the person whose turn
// it is. Their link stops working at once; the new person gets their own; the sender is told who and why.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { useT } from '@/i18n/client';
import { delegateAction } from './actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';

export function HandOffControl({ className }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);

  const handOff = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await delegateAction({ name, email, reason }).catch(() => ({ ok: false as const, message: t('common.offlineNothingChanged') }));
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    // the link is switched off the moment the hand-off is recorded, so show a page that needs no session
    router.replace('/sign/handed-off');
  };

  return (
    <>
      <Button type="button" variant="quiet" className={className} onClick={() => setOpen(true)}>
        {t('handoff.button')}
      </Button>
      {open ? (
        <dialog
          ref={dialog}
          onClose={() => setOpen(false)}
          aria-labelledby="handoff-title"
          className="m-auto w-[min(36rem,calc(100vw-1.5rem))] rounded-lg bg-surface p-0 text-ink shadow-soft backdrop:bg-ink/60"
        >
          <form
            className="flex flex-col gap-4 p-5 sm:p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void handOff();
            }}
          >
            <h2 id="handoff-title" className="text-xl font-medium text-ink">
              {t('handoff.title')}
            </h2>
            <p className="text-base text-ink-body">
              {t('handoff.body')}
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="handoff-name" className="text-sm font-medium text-ink">
                {t('handoff.name')}
              </label>
              <input id="handoff-name" value={name} maxLength={120} required autoComplete="off" onChange={(e) => setName(e.target.value)} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="handoff-email" className="text-sm font-medium text-ink">
                {t('handoff.email')}
              </label>
              <input id="handoff-email" type="email" value={email} maxLength={254} required autoComplete="off" onChange={(e) => setEmail(e.target.value)} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="handoff-reason" className="text-sm font-medium text-ink">
                {t('handoff.reason')}
              </label>
              <textarea id="handoff-reason" value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => dialog.current?.close()} disabled={busy}>
                {t('common.goBack')}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t('handoff.busy') : t('handoff.submit')}
              </Button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );
}
