'use client';
// "Report this document": on every signer page. A small form that tells the platform administrators
// that something is wrong with the document (it was not expected, it looks like fraud, ...).
import { useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { PRODUCT_NAME } from '@/config/brand';
import { useT } from '@/i18n/client';

export function ReportAbuse({ token, startOpen = false }: { token?: string; startOpen?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | 'reported' | 'already'>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sign/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token ? { reason, token } : { reason }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string };
      if (res.ok && data.ok) setDone(data.already ? 'already' : 'reported');
      else setError(data.error ?? t('abuse.failed'));
    } catch {
      setError(t('common.offlineConnection'));
    }
    setBusy(false);
  }

  if (done) {
    return (
      <Notice tone="success">
        {done === 'already' ? t('abuse.doneAlready', { product: PRODUCT_NAME }) : t('abuse.doneReported', { product: PRODUCT_NAME })} {t('abuse.doneTail')}
      </Notice>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 text-left text-sm text-ink-muted underline underline-offset-2 hover:text-ink">
        {t('abuse.open')}
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-3 rounded-md border border-hairline p-4">
      <h2 className="text-base font-medium text-ink">{t('abuse.title')}</h2>
      <p className="text-sm text-ink-body">{t('abuse.intro', { product: PRODUCT_NAME })}</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="report-reason" className="text-sm font-medium text-ink">
          {t('abuse.label')}
        </label>
        <textarea id="report-reason" name="reason" required minLength={3} maxLength={2000} rows={3} className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t('common.sending') : t('abuse.send')}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The footer of every signer page. The link page shows its own copy (it still holds the link), so it is hidden there. */
export function ReportAbuseFooter() {
  const pathname = usePathname();
  if (pathname === '/s') return null;
  return (
    <footer className="border-t border-hairline px-4 py-4 sm:px-6">
      <ReportAbuse />
    </footer>
  );
}
