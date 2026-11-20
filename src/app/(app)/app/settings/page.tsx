import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { RetentionForm } from './retention-form';
import { ExportSection } from './export-section';

export const metadata: Metadata = { title: 'Settings' };

async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser('/app/settings');
  const exportNote = (await searchParams).export;
  const supabase = await createSupabaseServerClient();
  const { data: membership } = await supabase.from('memberships').select('org_id, role, organizations(name)').eq('user_id', user.id).order('created_at').limit(1).maybeSingle();
  if (!membership) return <p className="text-ink-body">You do not belong to a workspace.</p>;
  const { data: controls } = await supabaseAdmin().from('org_controls').select('retention_years').eq('org_id', membership.org_id).maybeSingle();
  const org = Array.isArray(membership.organizations) ? membership.organizations[0] : membership.organizations;
  return (
    <>
    <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="retention-heading">
      <p className="text-sm text-ink-muted">{(org as { name?: string } | null)?.name ?? 'Your workspace'}</p>
      <h2 id="retention-heading" className="mb-3 mt-1 text-base font-medium text-ink">How long finished documents are kept</h2>
      <RetentionForm orgId={membership.org_id as string} years={Number(controls?.retention_years ?? 7)} owner={membership.role === 'owner'} />
    </section>
    <ExportSection owner={membership.role === 'owner'} note={typeof exportNote === 'string' ? exportNote : null} />
    </>
  );
}

export default function SettingsPage({ searchParams }: PageProps<'/app/settings'>) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-medium text-ink">Settings</h1>
      <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
        <Settings searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
