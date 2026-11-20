import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser, mfaStatus } from '@/lib/auth/session';
import { safeNext } from '@/lib/auth/mfa-policy';
import { MfaCodeForm } from './mfa-forms';

export const metadata: Metadata = { title: 'Two-step sign-in' };

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  const status = await mfaStatus(user.id);
  if (!status.enrolled && status.admin) redirect('/app/account/security?required=admin');
  if (!status.enrolled) {
    // No redirect here: right after a recovery code is used this page is refreshed once more, and a redirect
    // would race the action's own redirect to the security page.
    return (
      <>
        <h1 className="text-2xl font-medium text-ink">Two-step sign-in is off</h1>
        <p className="mt-2 text-base text-ink-body">There is no code to enter for this account.</p>
        <p className="mt-4 text-base">
          <Link href="/app/account/security">Set up two-step sign-in</Link> or <Link href={next}>continue</Link>.
        </p>
      </>
    );
  }
  const fresh = sp.fresh === '1';
  return (
    <>
      <h1 className="text-2xl font-medium text-ink">{fresh ? 'Confirm it is you' : 'Two-step sign-in'}</h1>
      <p className="mt-2 text-base text-ink-body">
        {fresh
          ? 'The administrator pages need a code from your authenticator app at least every 12 hours. Open the app and enter the six-digit code it shows for YouNMeSign.'
          : 'Open your authenticator app and enter the six-digit code it shows for YouNMeSign.'}
      </p>
      <MfaCodeForm next={next} />
    </>
  );
}

export default function MfaPage({ searchParams }: PageProps<'/mfa'>) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
      <Body searchParams={searchParams} />
    </Suspense>
  );
}
