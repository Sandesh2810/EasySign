'use client';
// "Report this document": on every signer page. A small form that tells the platform administrators
// that something is wrong with the document (it was not expected, it looks like fraud, ...).
import { useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Button, Notice } from '@/components/ui';

export function ReportAbuse({ token, startOpen = false }: { token?: string; startOpen?: boolean }) {
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
      else setError(data.error ?? 'The report could not be sent. Please try again.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    setBusy(false);
  }

  if (done) {
    return (
      <Notice tone="success">
        {done === 'already' ? 'You have already reported this document. The YouNMeSign administrators have your report.' : 'Thank you. Your report has gone to the YouNMeSign administrators, who will look at it.'} You do
        not have to sign anything. If you think you are being defrauded, do not send money or personal details to anyone because of this document.
      </Notice>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 text-left text-sm text-ink-muted underline underline-offset-2 hover:text-ink">
        Not expecting this, or something looks wrong? Report this document
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-3 rounded-md border border-hairline p-4">
      <h2 className="text-base font-medium text-ink">Report this document</h2>
      <p className="text-sm text-ink-body">
        Tell us what is wrong, for example that you do not know the sender or that it asks for something suspicious. Your report goes to the people who run YouNMeSign, not to the sender. Reporting does
        not sign or decline anything.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="report-reason" className="text-sm font-medium text-ink">
          What is wrong?
        </label>
        <textarea id="report-reason" name="reason" required minLength={3} maxLength={2000} rows={3} className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send report'}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
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
