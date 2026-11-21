import type { Metadata } from 'next';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth/session';
import { openInPersonSessions } from '@/lib/in-person-host';
import { signOutAction } from '../actions';
import { ReturnForm } from './return-form';

export const metadata: Metadata = { title: 'In-person signing in progress' };

// D-86: while the host's device is with an in-person signer, every page of the host's account sends them here.
export default function InPersonHostPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
      <HostReturn />
    </Suspense>
  );
}

async function HostReturn() {
  const user = await getUser();
  if (!user) redirect('/login');
  const open = await openInPersonSessions(user.id);
  if (!open.length) redirect('/app');
  const s = open[0];
  return (
    <>
      <h1 className="text-2xl font-medium text-ink">In-person signing in progress</h1>
      <p className="mt-3 text-base text-ink-body">
        This device is being used for in-person signing of &ldquo;{s.title}&rdquo; by {s.signer_name}. To return to your account, enter the PIN you chose when you started. This ends the in-person signing.
      </p>
      <ReturnForm sessionId={s.session_id} />
      <p className="mt-8 text-sm text-ink-muted">Forgot the PIN? Signing out ends the in-person signing too; then sign in again.</p>
      <form action={signOutAction} className="mt-2">
        <button type="submit" className="min-h-11 text-base text-periwinkle-ink underline-offset-4 hover:underline">
          Sign out
        </button>
      </form>
    </>
  );
}
