'use client';
// D-86 (AT4.7): start in-person signing for a person whose turn it is. The host chooses a PIN; this device then
// becomes the person's signing screen, and the host's account asks for the PIN until the signing is handed back.
import { useEffect, useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { startInPersonAction } from '../in-person-actions';

const PIN_INPUT = 'min-h-11 w-48 rounded-sm border border-control-border bg-surface px-3 text-base tracking-widest text-ink';

export function StartInPerson({ envelopeId, recipientId, name }: { envelopeId: string; recipientId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await startInPersonAction({ envelopeId, recipientId, pin, confirm }).catch(() => ({ ok: false as const, message: 'We could not reach the server. Nothing was changed. Try again.' }));
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    // a full page load into the signing screen: the modal closes with this page and nothing of the account stays loaded
    dialog.current?.close();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full page load (D-86): an in-app move left this modal open over the signing screen and kept the account pages loaded
    window.location.assign('/sign');
  };

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);

  return (
    <>
      <Button type="button" variant="outline" className="mt-2" onClick={() => setOpen(true)}>
        Start signing in person
      </Button>
      {open ? (
        <dialog
          ref={dialog}
          onClose={() => setOpen(false)}
          aria-labelledby={`inperson-title-${recipientId}`}
          className="m-auto w-[min(36rem,calc(100vw-1.5rem))] rounded-lg bg-surface p-0 font-normal text-ink shadow-soft backdrop:bg-ink/60"
        >
          <form
            className="flex flex-col gap-4 p-5 sm:p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <h2 id={`inperson-title-${recipientId}`} className="text-xl font-medium text-ink">
              Sign in person with {name}
            </h2>
            <p className="text-base text-ink-body">
              This device becomes {name}&apos;s signing screen. Stay with them and check who they are. Choose a PIN that only you know: you need it to unlock the screen if it locks itself after
              3 minutes without use, and to take the device back at the end. Until then your account on this device asks for the PIN.
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`pin-${recipientId}`} className="text-sm font-medium text-ink">
                Your PIN (4 to 8 digits)
              </label>
              <input id={`pin-${recipientId}`} type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(digits(e.target.value))} className={PIN_INPUT} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`pin2-${recipientId}`} className="text-sm font-medium text-ink">
                The same PIN again
              </label>
              <input id={`pin2-${recipientId}`} type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} className={PIN_INPUT} />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy || pin.length < 4 || confirm.length < 4}>
                {busy ? 'Opening…' : `Hand the device to ${name}`}
              </Button>
              <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
                Cancel
              </Button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );
}
