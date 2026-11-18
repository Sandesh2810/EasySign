import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { describeNotification } from '@/lib/notifications';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui';
import { markAllReadAction } from './actions';
import { DigestForm } from './digest-form';

export const metadata: Metadata = { title: 'Notifications' };

export default function NotificationsPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading your notifications…</p>}>
      <Notifications />
    </Suspense>
  );
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

// Reads through the person's own session: row-level security returns only their notices.
async function Notifications() {
  const user = await requireUser('/app/notifications');
  const supabase = await createSupabaseServerClient();
  const [{ data: notices }, { data: profile }] = await Promise.all([
    supabase.from('notifications').select('id, kind, payload, read_at, created_at').order('created_at', { ascending: false }).limit(100),
    supabase.from('profiles').select('digest_opt_in').eq('id', user.id).maybeSingle(),
  ]);
  const list = notices ?? [];
  const unread = list.filter((n) => !n.read_at).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-muted">
            <Link href="/app">Dashboard</Link> / Notifications
          </p>
          <h1 className="mt-2 font-serif text-4xl font-light italic text-ink">Notifications</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-body">
            What happened on your documents: who signed, what was completed, declined or expired, and any email that had to wait. These are shown here and are not emailed,
            unless you switch on the daily summary below.
          </p>
        </div>
        {unread > 0 ? (
          <form action={markAllReadAction}>
            <Button type="submit" variant="outline" className="min-h-11 px-5 text-sm">
              Mark all as read ({unread})
            </Button>
          </form>
        ) : null}
      </div>

      <section className="rounded-lg bg-surface shadow-soft" aria-label="Your notifications">
        {list.length === 0 ? (
          <p className="px-6 py-10 text-center text-ink-body">Nothing yet. When someone signs or a document is completed, it shows up here.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((n) => {
              const view = describeNotification(n.kind as string, n.payload);
              return (
                <li key={n.id as string} className={n.read_at ? 'px-6 py-4' : 'border-l-4 border-ink bg-surface-sand px-5 py-4'}>
                  <p className="text-base text-ink">
                    {!n.read_at ? <span className="sr-only">New: </span> : null}
                    {view.text}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
                    <time dateTime={n.created_at as string}>{when(n.created_at as string)}</time>
                    {view.path ? <Link href={view.path}>Open the document</Link> : null}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg bg-surface px-6 py-5 shadow-soft" aria-labelledby="digest-heading">
        <h2 id="digest-heading" className="text-base font-medium text-ink">
          Daily summary by email
        </h2>
        <p className="mb-4 mt-2 max-w-2xl text-sm text-ink-body">
          Optional. At most one email a day, and only on days when something happened. It lists the same notices you see above. Because the number of emails per day is
          limited, the summary goes out last: on a busy day it may arrive a day late, and requests to sign always go first.
        </p>
        <DigestForm on={Boolean(profile?.digest_opt_in)} />
      </section>
    </div>
  );
}
