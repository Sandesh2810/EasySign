'use client';
// "Decline": available to anyone who must sign or approve, while it is their turn. Declining stops the
// document for everyone, so it asks for confirmation and offers space for a reason the sender will see.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { useT } from '@/i18n/client';
import { declineAction } from './actions';

export function DeclineControl({ label, variant = 'outline', className }: { label?: string; variant?: 'outline' | 'quiet'; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);

  const decline = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await declineAction(reason).catch(() => ({ ok: false as const, message: t('common.offlineNothingChanged') }));
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    // the link is switched off the moment the decline is recorded, so show a page that needs no session
    router.replace('/sign/declined');
  };

  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => setOpen(true)}>
        {label ?? t('decline.button')}
      </Button>
      {open ? (
        <dialog
          ref={dialog}
          onClose={() => setOpen(false)}
          aria-labelledby="decline-title"
          className="m-auto w-[min(36rem,calc(100vw-1.5rem))] rounded-lg bg-surface p-0 text-ink shadow-soft backdrop:bg-ink/60"
        >
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <h2 id="decline-title" className="text-xl font-medium text-ink">
              {t('decline.title')}
            </h2>
            <p className="text-base text-ink-body">
              {t('decline.body')}
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="decline-reason" className="text-sm font-medium text-ink">
                {t('decline.reason')}
              </label>
              <textarea
                id="decline-reason"
                value={reason}
                maxLength={1000}
                rows={3}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink"
              />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => dialog.current?.close()} disabled={busy}>
                {t('common.goBack')}
              </Button>
              <Button type="button" onClick={() => void decline()} disabled={busy}>
                {busy ? t('decline.busy') : t('decline.submit')}
              </Button>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
