import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Notice } from '@/components/ui';
import { mfaStatus, requireUser } from '@/lib/auth/session';
import { SecurityPanel } from './security-panel';

export const metadata: Metadata = { title: 'Account security' };

async function Security({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser('/app/account/security');
  const sp = await searchParams;
  const status = await mfaStatus(user.id);
  return (
    <>
      {sp.required === 'admin' && !status.enrolled ? (
        <Notice tone="info">As the administrator you must switch on two-step sign-in before you can open the administrator pages.</Notice>
      ) : null}
      {sp.recovered === '1' ? (
        <Notice tone="info">You used a recovery code, so two-step sign-in was switched off. Set it up again now on your new phone.</Notice>
      ) : null}
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="mfa-heading">
        <h2 id="mfa-heading" className="mb-3 text-base font-medium text-ink">Two-step sign-in</h2>
        <SecurityPanel enrolled={status.enrolled} admin={status.admin} codesLeft={status.codesLeft} />
      </section>
    </>
  );
}

export default function SecurityPage({ searchParams }: PageProps<'/app/account/security'>) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-medium text-ink">Account security</h1>
      <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
        <Security searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
