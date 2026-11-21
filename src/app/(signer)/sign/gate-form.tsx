'use client';
// The code screen shown before a document opens, when the sender asked for an extra identity check.
// It talks to POST /api/sign/gate, which counts wrong tries and, on success, upgrades the session.
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { rich, useT } from '@/i18n/client';
import type { T } from '@/i18n/format';

type Reply = { ok: boolean; message: string };

async function post(t: T, payload: { action: 'access_code' | 'request_code' | 'email_code'; code?: string }): Promise<Reply> {
  try {
    const res = await fetch('/api/sign/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return res.ok && data.ok ? { ok: true, message: data.message ?? '' } : { ok: false, message: data.error ?? t('common.somethingWrong') };
  } catch {
    return { ok: false, message: t('common.offlineConnection') };
  }
}

const inputClass =
  'min-h-12 w-full max-w-xs rounded-md border border-control-border bg-surface px-4 text-lg tracking-widest text-ink focus:outline-2 focus:outline-offset-2 focus:outline-focus';

export function AccessCodeForm({ lockedText }: { lockedText: string | null }) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setBusy(true);
    const reply = await post(t, { action: 'access_code', code });
    setBusy(false);
    if (reply.ok) router.refresh();
    else setError(reply.message);
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="gate-code" className="text-base font-medium text-ink">
          {t('gate.accessCode')}
        </label>
        <input id="gate-code" name="code" type="text" required autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={200} className={inputClass} aria-describedby="gate-code-hint" />
        <p id="gate-code-hint" className="text-sm text-ink-muted">
          {t('gate.accessHint')}
        </p>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : lockedText ? <Notice tone="danger">{lockedText}</Notice> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? t('common.checking') : t('gate.open')}
        </Button>
      </div>
    </form>
  );
}

export function EmailCodeForm({ maskedEmail, otpStatus, lockedText }: { maskedEmail: string; otpStatus: 'none' | 'sending' | 'sent' | 'delayed' | 'failed'; lockedText: string | null }) {
  const t = useT();
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
    const reply = await post(t, { action: 'request_code' });
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
    const reply = await post(t, { action: 'email_code', code });
    setBusy(null);
    if (reply.ok) router.refresh();
    else setVerifyError(reply.message);
  }

  const statusLine =
    otpStatus === 'sent'
      ? t('gate.otpSent', { email: maskedEmail })
      : otpStatus === 'delayed'
        ? t('gate.otpDelayed')
        : otpStatus === 'failed'
          ? t('gate.otpFailed')
          : otpStatus === 'sending'
            ? t('gate.otpSending', { email: maskedEmail })
            : null;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-base text-ink-body">
          {rich(t, 'gate.otpIntro', { email: <strong className="font-medium text-ink">{maskedEmail}</strong> })}
        </p>
        {requestError ? <Notice tone="danger">{requestError}</Notice> : null}
        {statusLine ? (
          <p role="status" className="text-sm text-ink-body">
            {statusLine}
          </p>
        ) : null}
        <div>
          <Button type="button" variant={asked ? 'outline' : 'primary'} disabled={busy !== null} onClick={request}>
            {busy === 'request' ? t('gate.asking') : asked ? t('gate.newCode') : t('gate.emailMe')}
          </Button>
        </div>
      </div>

      {asked ? (
        <form onSubmit={verify} className="flex flex-col gap-4 border-t border-hairline pt-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="gate-otp" className="text-base font-medium text-ink">
              {t('gate.otpLabel')}
            </label>
            <input id="gate-otp" name="code" type="text" inputMode="numeric" pattern="[0-9 ]*" required autoComplete="one-time-code" maxLength={12} className={inputClass} />
          </div>
          {verifyError ? <Notice tone="danger">{verifyError}</Notice> : lockedText ? <Notice tone="danger">{lockedText}</Notice> : null}
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === 'verify' ? t('common.checking') : t('gate.open')}
            </Button>
          </div>
        </form>
      ) : lockedText ? (
        <Notice tone="danger">{lockedText}</Notice>
      ) : null}
    </div>
  );
}
