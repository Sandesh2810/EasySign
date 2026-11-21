'use client';
import { useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { submitPowerFormAction } from './actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';

export function PublicForm({ slug, token }: { slug: string; token: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-6 flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        const res = await submitPowerFormAction({ slug, name, email, website, token }).catch((err: unknown) => {
          // the signing page opens by a redirect from the server
          if (err && typeof err === 'object' && 'digest' in err && String((err as { digest: unknown }).digest).startsWith('NEXT_REDIRECT')) throw err;
          return { ok: false as const, message: 'We could not reach the server. Try again.' };
        });
        setBusy(false);
        if (!res.ok) setError(res.message);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-name" className="text-sm font-medium text-ink">
          Your full name
        </label>
        <input id="pf-name" value={name} maxLength={120} required autoComplete="name" onChange={(e) => setName(e.target.value)} className={INPUT} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pf-email" className="text-sm font-medium text-ink">
          Your email address
        </label>
        <input id="pf-email" type="email" value={email} maxLength={254} required autoComplete="email" onChange={(e) => setEmail(e.target.value)} className={INPUT} />
      </div>
      {/* a trap for automated form fillers: hidden from people and from assistive technology, never filled by a person */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="pf-website">Website</label>
        <input id="pf-website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Preparing your document…' : 'Continue to sign'}
        </Button>
      </div>
    </form>
  );
}
