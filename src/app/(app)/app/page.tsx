import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Notice } from '@/components/ui';
import { StatusChip } from '@/components/status-chip';
import { NO_PHI_NOTICE } from '@/config/brand';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading your dashboard…</p>}>
      <Dashboard />
    </Suspense>
  );
}

// Reads only through the user's own session, so row-level security decides what is visible.
async function Dashboard() {
  const user = await requireUser('/app');
  const supabase = await createSupabaseServerClient();
  const [{ data: profile }, { data: controls }, { data: memberships }, { data: envelopes }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
    supabase.from('account_controls').select('approved, trust_level').eq('user_id', user.id).maybeSingle(),
    supabase.from('memberships').select('role, organizations(name)').eq('user_id', user.id),
    supabase.from('envelopes').select('id, title, status, public_code, created_at').order('created_at', { ascending: false }).limit(50),
  ]);

  const workspace = (memberships?.[0] as { role: string; organizations: { name: string } | { name: string }[] | null } | undefined) ?? null;
  const org = Array.isArray(workspace?.organizations) ? workspace?.organizations[0] : workspace?.organizations;
  const list = envelopes ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-widest text-ink-muted">{org?.name ?? 'Dashboard'}</p>
          <h1 className="mt-1 font-serif text-4xl font-light italic text-ink">Hello{profile?.display_name ? `, ${profile.display_name}` : ''}</h1>
        </div>
        <Link href="/app/new" className="inline-flex min-h-11 items-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline">
          New document
        </Link>
      </div>

      {controls && !controls.approved ? (
        <Notice tone="info">
          Your account is waiting for approval. You can prepare documents and sign them yourself now; sending to other people unlocks once an administrator approves your account.
        </Notice>
      ) : null}
      {controls?.trust_level === 'suspended' ? <Notice tone="danger">This account is suspended. Contact the administrator.</Notice> : null}

      <section className="rounded-lg bg-surface shadow-soft">
        <h2 className="border-b border-hairline px-6 py-4 text-base font-medium text-ink">Documents</h2>
        {list.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-lg text-ink">No documents yet</p>
            <p className="mt-1 text-sm text-ink-muted">Upload a PDF or a photo of a document to get started.</p>
            <p className="mt-4">
              <Link href="/app/new">Upload your first document</Link>
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((e) => (
              <li key={e.id}>
                <Link href={`/app/envelopes/${e.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-6 py-3 text-ink no-underline hover:bg-surface-sand">
                  <span className="min-w-0">
                    <span className="block truncate text-base">{e.title}</span>
                    <span className="block font-mono text-xs text-ink-muted">{e.public_code}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-sm text-ink-muted">{new Date(e.created_at).toISOString().slice(0, 10)}</span>
                    <StatusChip status={e.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm text-ink-muted">{NO_PHI_NOTICE}</p>
    </div>
  );
}
