'use client';
// Set up two-step sign-in, make new recovery codes, or switch it off (Phase 3 slice 4, AT3.4).
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice, TextField } from '@/components/ui';
import { confirmEnrollAction, newRecoveryCodesAction, removeMfaAction, startEnrollAction } from '@/lib/auth/mfa-actions';

const OFFLINE = 'We could not reach the server. Nothing was changed. Try again.';

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface-sand p-4">
      <p className="text-base font-medium text-ink">Your recovery codes. Save them now: they are shown only this once.</p>
      <p className="text-sm text-ink-body">
        If you lose your phone, one of these codes lets you back in. Each works once. Print them or keep them in a password manager, not on the phone with the authenticator app.
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-base text-ink" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

export function SecurityPanel({ enrolled, admin, codesLeft }: { enrolled: boolean; admin: boolean; codesLeft: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const router = useRouter();

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setMessage(null);
      await fn().catch(() => setError(OFFLINE));
    });

  if (codes) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success">Two-step sign-in is on.</Notice>
        <RecoveryCodes codes={codes} />
        <div>
          <Button type="button" onClick={() => { setCodes(null); router.refresh(); }}>I have saved my codes</Button>
        </div>
      </div>
    );
  }

  if (!enrolled && setup) {
    return (
      <div className="flex flex-col gap-4">
        <ol className="list-decimal pl-5 text-base text-ink-body">
          <li>Open an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or 1Password).</li>
          <li>Add an account and scan this code. If you cannot scan, type the key below instead.</li>
          <li>Enter the six-digit code the app shows.</li>
        </ol>
        {/* Supabase Auth returns the QR code as an SVG data URL */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={setup.qr} alt="QR code to add YouNMeSign to your authenticator app" width={200} height={200} className="rounded-md bg-white p-2" />
        <p className="text-sm text-ink-body">
          Key: <span className="break-all font-mono text-ink" data-testid="totp-secret">{setup.secret}</span>
        </p>
        <TextField id="enroll-code" label="Six-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const res = await confirmEnrollAction(setup.factorId, code);
                if (!res.ok) setError(res.message);
                else if (res.codes) setCodes(res.codes);
                else { setMessage(res.message ?? null); router.refresh(); }
              })
            }
          >
            {pending ? 'Checking…' : 'Switch on'}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => setSetup(null)}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (!enrolled) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-base text-ink-body">
          Two-step sign-in is <strong>off</strong>. With it on, signing in needs your password and a six-digit code from an app on your phone, so a stolen password alone is not enough.
        </p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div>
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const res = await startEnrollAction();
                if (res.ok) setSetup({ factorId: res.factorId, qr: res.qr, secret: res.secret });
                else setError(res.message);
              })
            }
          >
            {pending ? 'One moment…' : 'Set up two-step sign-in'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-ink-body">
        Two-step sign-in is <strong>on</strong>. You have {codesLeft} unused recovery {codesLeft === 1 ? 'code' : 'codes'}.
      </p>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const res = await newRecoveryCodesAction();
              if (!res.ok) setError(res.message);
              else if (res.codes) setCodes(res.codes);
            })
          }
        >
          Make new recovery codes
        </Button>
        {admin ? null : (
          <Button
            type="button"
            variant="quiet"
            disabled={pending}
            onClick={() =>
              run(async () => {
                if (!window.confirm('Switch two-step sign-in off? Your recovery codes stop working too.')) return;
                const res = await removeMfaAction();
                if (!res.ok) setError(res.message);
                else { setMessage(res.message ?? null); router.refresh(); }
              })
            }
          >
            Switch off
          </Button>
        )}
      </div>
      {admin ? <p className="text-sm text-ink-muted">As the administrator you must keep it on.</p> : null}
    </div>
  );
}
