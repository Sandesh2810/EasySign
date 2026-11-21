'use client';
// In-person signing on the host's device (D-86, AT4.7).
// InPersonGuard: a banner naming the host, a "Lock the screen" button, and the inactivity lock: after IDLE_LOCK_SECONDS
// without a touch, click or key press the screen locks (a warning shows IDLE_WARNING_SECONDS before, and any touch or
// key press keeps it open: WCAG 2.2.1). While the screen is in use the server is told every HEARTBEAT_SECONDS; it
// refuses every signer action once the session is locked, so the lock does not depend on this page alone.
// HostPinForm: the host's PIN, to unlock the screen or to take the device back at the end.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { HEARTBEAT_SECONDS, IDLE_LOCK_SECONDS, IDLE_WARNING_SECONDS } from '@/lib/in-person';
import { handBackAction, inPersonHeartbeatAction, lockInPersonAction, unlockInPersonAction } from './in-person-actions';

const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

export function InPersonGuard({ hostName, signerName, children }: { hostName: string; signerName: string; children: React.ReactNode }) {
  const router = useRouter();
  // both set when the screen appears (in the effect below), not during render
  const lastActive = useRef(0);
  const lastReported = useRef(0);
  const locking = useRef(false);
  const [warn, setWarn] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(IDLE_WARNING_SECONDS);

  const lock = useCallback(
    async (reason: 'inactive' | 'manual') => {
      if (locking.current) return;
      locking.current = true;
      await lockInPersonAction(reason).catch(() => undefined);
      router.refresh();
    },
    [router],
  );

  useEffect(() => {
    lastActive.current = Date.now();
    lastReported.current = Date.now();
    const mark = () => {
      lastActive.current = Date.now();
      setWarn(false);
    };
    for (const ev of ACTIVITY) window.addEventListener(ev, mark, { passive: true, capture: true });
    const tick = window.setInterval(() => {
      const idle = (Date.now() - lastActive.current) / 1000;
      if (idle >= IDLE_LOCK_SECONDS) {
        void lock('inactive');
        return;
      }
      if (idle >= IDLE_LOCK_SECONDS - IDLE_WARNING_SECONDS) {
        setWarn(true);
        setSecondsLeft(Math.max(1, Math.ceil(IDLE_LOCK_SECONDS - idle)));
      }
      // in use since the last report: tell the server (it locks sessions that go quiet for 5 minutes on its own)
      if (lastActive.current > lastReported.current && Date.now() - lastReported.current >= HEARTBEAT_SECONDS * 1000) {
        lastReported.current = Date.now();
        void inPersonHeartbeatAction()
          .then((state) => {
            if (state !== 'active') router.refresh();
          })
          .catch(() => undefined);
      }
    }, 1000);
    return () => {
      for (const ev of ACTIVITY) window.removeEventListener(ev, mark, { capture: true });
      window.clearInterval(tick);
    };
  }, [lock, router]);

  return (
    <>
      <div className="border-b border-hairline bg-surface-sand">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm text-ink">
            <strong className="font-medium">Signing in person</strong> with {hostName}. This screen is for {signerName}.
          </p>
          <Button type="button" variant="outline" onClick={() => void lock('manual')}>
            Lock the screen
          </Button>
        </div>
      </div>
      {warn ? (
        <div role="alertdialog" aria-labelledby="idle-title" aria-describedby="idle-body" className="fixed inset-x-0 bottom-0 z-50 border-t border-hairline bg-surface p-4 shadow-soft">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            <div>
              <p id="idle-title" className="text-base font-medium text-ink">
                Still there?
              </p>
              <p id="idle-body" className="text-sm text-ink-body" aria-live="polite">
                For privacy the screen locks in {secondsLeft} seconds. Touch the screen or press any key to keep going.
              </p>
            </div>
            <Button type="button" onClick={() => setWarn(false)}>
              Keep going
            </Button>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
}

export function HostPinForm({ mode, hostName }: { mode: 'unlock' | 'handback'; hostName: string }) {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await (mode === 'unlock' ? unlockInPersonAction(pin) : handBackAction(pin)).catch((e: unknown) => {
      // a redirect from the server (hand-back done, or signed out after too many wrong PINs) is not an error
      if (e && typeof e === 'object' && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_REDIRECT')) throw e;
      return { ok: false as const, message: 'We could not reach the server. Try again.' };
    });
    setBusy(false);
    setPin('');
    if (!res.ok) {
      setError(res.message);
      return;
    }
    router.refresh();
  };
  return (
    <form
      className="mt-6 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="host-pin" className="text-sm font-medium text-ink">
        {hostName}&apos;s PIN
      </label>
      <input
        id="host-pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]*"
        maxLength={8}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        className="min-h-11 w-48 rounded-sm border border-control-border bg-surface px-3 text-base tracking-widest text-ink"
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div>
        <Button type="submit" disabled={busy || pin.length < 4}>
          {busy ? 'Checking…' : mode === 'unlock' ? 'Unlock' : 'Take the device back'}
        </Button>
      </div>
    </form>
  );
}
