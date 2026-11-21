import { Suspense } from 'react';
import Link from 'next/link';
import { PRODUCT_NAME } from '@/config/brand';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui';
import { signOutAction } from '../(auth)/actions';
import { activeWorkspace, ROLE_LABEL } from '@/lib/workspace';
import { switchWorkspaceAction } from './app/team/actions';

// Pages under /app depend on who is signed in, so they are rendered for each request rather than
// prepared ahead of the click; this tells Next.js not to flag that as a missed optimisation.
export const instant = false;

// Everything under /app requires a signed-in user. The session is read at request time, so it
// sits behind a Suspense boundary (required with Cache Components); the frame renders instantly.
async function AccountMenu() {
  const user = await requireUser('/app');
  // Only decides whether to show the link; the page and its actions check again in the database.
  const supabase = await createSupabaseServerClient();
  const [{ data: controls }, unread, workspaces] = await Promise.all([
    supabase.from('account_controls').select('is_platform_admin').eq('user_id', user.id).maybeSingle(),
    // row-level security limits this to the person's own notices
    supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    activeWorkspace(user.id).catch(() => null),
  ]);
  const unreadCount = unread.count ?? 0;
  return (
    <nav aria-label="Account" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {workspaces && workspaces.all.length > 1 ? (
        // Only lists workspaces the database says this person may use now; the action checks again.
        <form action={switchWorkspaceAction} className="flex items-center gap-2">
          <label htmlFor="workspace-switch" className="sr-only">
            Workspace
          </label>
          <select
            id="workspace-switch"
            name="org_id"
            defaultValue={workspaces.current.orgId}
            className="min-h-10 max-w-[12rem] rounded-sm border border-control-border bg-surface px-2 text-sm text-ink"
          >
            {workspaces.all.map((w) => (
              <option key={w.orgId} value={w.orgId}>
                {w.name} ({ROLE_LABEL[w.role]})
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" className="min-h-10 px-3 text-sm">
            Switch
          </Button>
        </form>
      ) : null}
      <Link href="/app/templates" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
        Templates
      </Link>
      <Link href="/app/team" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
        Team
      </Link>
      <Link href="/app/reports" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
        Reports
      </Link>
      <Link href="/app/notifications" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
        Notifications
        {unreadCount > 0 ? (
          <span className="ml-1.5 inline-flex min-w-6 items-center justify-center rounded-pill bg-ink px-1.5 py-0.5 text-xs font-medium text-on-ink">
            {unreadCount > 99 ? '99+' : unreadCount}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </Link>
      {controls?.is_platform_admin ? (
        <Link href="/app/admin" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
          Accounts
        </Link>
      ) : null}
      <Link href="/app/settings" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
        Settings
      </Link>
      <Link href="/app/account/security" className="inline-flex min-h-11 items-center text-sm font-medium text-ink">
        Security
      </Link>
      <span className="hidden text-sm text-ink-muted sm:inline">{user.email}</span>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm">
          Sign out
        </Button>
      </form>
    </nav>
  );
}

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="min-h-dvh bg-surface-sand">
      <header className="border-b border-hairline bg-surface">
        {/* Wraps onto a second line on narrow screens or at high zoom instead of running off the edge (WCAG 1.4.10, slice 9). */}
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <Link href="/app" className="inline-flex min-h-11 items-center text-lg font-medium text-ink no-underline">
            {PRODUCT_NAME}
          </Link>
          <Suspense fallback={<span className="text-sm text-ink-muted">Loading…</span>}>
            <AccountMenu />
          </Suspense>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Suspense fallback={<p className="text-ink-muted">Loading your workspace…</p>}>{children}</Suspense>
      </main>
    </div>
  );
}
