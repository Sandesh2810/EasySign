import { Suspense } from 'react';
import Link from 'next/link';
import { PRODUCT_NAME } from '@/config/brand';
import { requireUser } from '@/lib/auth/session';
import { Button } from '@/components/ui';
import { signOutAction } from '../(auth)/actions';

// Pages under /app depend on who is signed in, so they are rendered for each request rather than
// prepared ahead of the click; this tells Next.js not to flag that as a missed optimisation.
export const instant = false;

// Everything under /app requires a signed-in user. The session is read at request time, so it
// sits behind a Suspense boundary (required with Cache Components); the frame renders instantly.
async function AccountMenu() {
  const user = await requireUser('/app');
  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-ink-muted sm:inline">{user.email}</span>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm">
          Sign out
        </Button>
      </form>
    </div>
  );
}

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="min-h-dvh bg-surface-sand">
      <header className="border-b border-hairline bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/app" className="text-lg font-medium text-ink no-underline">
            {PRODUCT_NAME}
          </Link>
          <Suspense fallback={<span className="text-sm text-ink-muted">Loading…</span>}>
            <AccountMenu />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Suspense fallback={<p className="text-ink-muted">Loading your workspace…</p>}>{children}</Suspense>
      </main>
    </div>
  );
}
