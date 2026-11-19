'use client';
// The code screen shown before a document opens, when the sender asked for an extra identity check.
// It talks to POST /api/sign/gate, which counts wrong tries and, on success, upgrades the session.
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';

type Reply = { ok: boolean; message: string };

async function post(payload: { action: 'access_code' | 'request_code' | 'email_code'; code?: string }): Promise<Reply> {
  try {
    const res = await fetch('/api/sign/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return res.ok && data.ok ? { ok: true, message: data.message ?? '' } : { ok: false, message: data.error ?? 'Something went wrong. Please try again.' };
  } catch {
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
  }
}

const inputClass =
  'min-h-12 w-full max-w-xs rounded-md border border-control-border bg-surface px-4 text-lg tracking-widest text-ink focus:outline-2 focus:outline-offset-2 focus:outline-focus';

export function AccessCodeForm({ lockedText }: { lockedText: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setBusy(true);
    const reply = await post({ action: 'access_code', code });
    setBusy(false);
    if (reply.ok) router.refresh();
    else setError(reply.message);
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="gate-code" className="text-base font-medium text-ink">
          Access code
        </label>
        <input id="gate-code" name="code" type="text" required autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={200} className={inputClass} aria-describedby="gate-code-hint" />
        <p id="gate-code-hint" className="text-sm text-ink-muted">
          The sender gave you this code separately, for example by phone or in person. It is not in the email with your link.
        </p>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : lockedText ? <Notice tone="danger">{lockedText}</Notice> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Open the document'}
        </Button>
      </div>
    </form>
  );
}

export function EmailCodeForm({ maskedEmail, otpStatus, lockedText }: { maskedEmail: string; otpStatus: 'none' | 'sending' | 'sent' | 'delayed' | 'failed'; lockedText: string | null }) {
  const router = useRouter();
  const [asked, setAsked] = useState(otpStatus !== 'none');
  const [requestError, setRequestError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'request' | 'verify' | null>(null);

  // While the email is on its way, ask the server now and then whether it has gone out.
  useEffect(() => {
    if (otpStatus !== 'sending') return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [otpStatus, router]);

  async function request() {
    setBusy('request');
    setRequestError(null);
    const reply = await post({ action: 'request_code' });
    setBusy(null);
    if (reply.ok) {
      setAsked(true);
      setVerifyError(null);
      router.refresh();
    } else setRequestError(reply.message);
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setBusy('verify');
    const reply = await post({ action: 'email_code', code });
    setBusy(null);
    if (reply.ok) router.refresh();
    else setVerifyError(reply.message);
  }

  const statusLine =
    otpStatus === 'sent'
      ? `We emailed a code to ${maskedEmail}. It works once, for 10 minutes. Check your spam folder if you do not see it.`
      : otpStatus === 'delayed'
        ? 'The code email is delayed because today’s email allowance is used up. It will be sent after the daily reset (00:00 UTC). If this is urgent, contact the sender.'
        : otpStatus === 'failed'
          ? 'The last code email could not be sent. Ask for a new code.'
          : otpStatus === 'sending'
            ? `Sending a code to ${maskedEmail}…`
            : null;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-base text-ink-body">
          We will email a 6-digit code to <strong className="font-medium text-ink">{maskedEmail}</strong>, the address the sender has for you.
        </p>
        {requestError ? <Notice tone="danger">{requestError}</Notice> : null}
        {statusLine ? (
          <p role="status" className="text-sm text-ink-body">
            {statusLine}
          </p>
        ) : null}
        <div>
          <Button type="button" variant={asked ? 'outline' : 'primary'} disabled={busy !== null} onClick={request}>
            {busy === 'request' ? 'Asking…' : asked ? 'Send a new code' : 'Email me a code'}
          </Button>
        </div>
      </div>

      {asked ? (
        <form onSubmit={verify} className="flex flex-col gap-4 border-t border-hairline pt-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="gate-otp" className="text-base font-medium text-ink">
              6-digit code from the email
            </label>
            <input id="gate-otp" name="code" type="text" inputMode="numeric" pattern="[0-9 ]*" required autoComplete="one-time-code" maxLength={12} className={inputClass} />
          </div>
          {verifyError ? <Notice tone="danger">{verifyError}</Notice> : lockedText ? <Notice tone="danger">{lockedText}</Notice> : null}
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === 'verify' ? 'Checking…' : 'Open the document'}
            </Button>
          </div>
        </form>
      ) : lockedText ? (
        <Notice tone="danger">{lockedText}</Notice>
      ) : null}
    </div>
  );
}
