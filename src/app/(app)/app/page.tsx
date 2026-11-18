import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Notice } from '@/components/ui';
import { NO_PHI_NOTICE } from '@/config/brand';

export const metadata: Metadata = { title: 'Dashboard' };

// First signed-in screen. Reads only through the user's own session, so row-level security decides
// what is visible. The envelope list, folders and email meter arrive with the next slices.
export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading your dashboard…</p>}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  const user = await requireUser('/app');
  const supabase = await createSupabaseServerClient();
  const [{ data: profile }, { data: controls }, { data: memberships }, { count: envelopeCount }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
    supabase.from('account_controls').select('approved, trust_level').eq('user_id', user.id).maybeSingle(),
    supabase.from('memberships').select('role, organizations(name)').eq('user_id', user.id),
    supabase.from('envelopes').select('id', { count: 'exact', head: true }),
  ]);

  const workspace = (memberships?.[0] as { role: string; organizations: { name: string } | { name: string }[] | null } | undefined) ?? null;
  const org = Array.isArray(workspace?.organizations) ? workspace?.organizations[0] : workspace?.organizations;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm uppercase tracking-widest text-ink-muted">Dashboard</p>
        <h1 className="mt-1 font-serif text-4xl font-light italic text-ink">Hello{profile?.display_name ? `, ${profile.display_name}` : ''}</h1>
      </div>

      {controls && !controls.approved ? (
        <Notice tone="info">
          Your account is waiting for approval. You can prepare documents and sign them yourself now; sending to other people unlocks once an administrator approves your account.
        </Notice>
      ) : null}
      {controls?.trust_level === 'suspended' ? <Notice tone="danger">This account is suspended. Contact the administrator.</Notice> : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-surface p-6 shadow-soft">
          <p className="text-sm text-ink-muted">Workspace</p>
          <p className="mt-1 text-xl text-ink">{org?.name ?? 'Not found'}</p>
          <p className="mt-1 text-sm text-ink-muted">{workspace ? `You are the ${workspace.role}` : ''}</p>
        </div>
        <div className="rounded-lg bg-surface p-6 shadow-soft">
          <p className="text-sm text-ink-muted">Documents</p>
          <p className="mt-1 text-4xl font-extralight text-ink">{envelopeCount ?? 0}</p>
        </div>
        <div className="rounded-lg bg-surface p-6 shadow-soft">
          <p className="text-sm text-ink-muted">Status</p>
          <p className="mt-1 text-base text-ink-body">Uploading and sending are being built. Nothing here is ready for real documents yet.</p>
        </div>
      </section>

      <p className="text-sm text-ink-muted">{NO_PHI_NOTICE}</p>
    </div>
  );
}
