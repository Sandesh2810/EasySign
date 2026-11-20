import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace } from '@/lib/workspace';
import { RetentionForm } from './retention-form';
import { ExportSection } from './export-section';

export const metadata: Metadata = { title: 'Settings' };

async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser('/app/settings');
  const exportNote = (await searchParams).export;
  // settings of the workspace in use (owner-only parts are greyed out for everyone else)
  const { current: ws } = await activeWorkspace(user.id);
  const { data: controls } = await supabaseAdmin().from('org_controls').select('retention_years').eq('org_id', ws.orgId).maybeSingle();
  return (
    <>
    <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="retention-heading">
      <p className="text-sm text-ink-muted">{ws.name}</p>
      <h2 id="retention-heading" className="mb-3 mt-1 text-base font-medium text-ink">How long finished documents are kept</h2>
      <RetentionForm orgId={ws.orgId} years={Number(controls?.retention_years ?? 7)} owner={ws.role === 'owner'} />
    </section>
    <ExportSection owner={ws.role === 'owner'} note={typeof exportNote === 'string' ? exportNote : null} />
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
