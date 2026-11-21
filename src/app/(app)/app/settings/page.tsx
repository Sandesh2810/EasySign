import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace } from '@/lib/workspace';
import { RetentionForm } from './retention-form';
import { ExportSection } from './export-section';
import { BrandingForm } from './branding-form';
import { ApiKeys, type ApiKeyRow } from './api-keys';
import { monthInWords, usageLines, type Usage } from '@/lib/usage';

export const metadata: Metadata = { title: 'Settings' };

async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser('/app/settings');
  const exportNote = (await searchParams).export;
  // settings of the workspace in use (owner-only parts are greyed out for everyone else)
  const { current: ws } = await activeWorkspace(user.id);
  const { data: controls } = await supabaseAdmin().from('org_controls').select('retention_years').eq('org_id', ws.orgId).maybeSingle();
  const { data: apiKeys } = ws.role === 'owner' || ws.role === 'admin' ? await supabaseAdmin().rpc('api_key_list', { p_actor: user.id, p_org: ws.orgId }) : { data: [] };
  const { data: usage } = ws.role === 'owner' || ws.role === 'admin' ? await supabaseAdmin().rpc('usage_summary', { p_actor: user.id, p_org: ws.orgId, p_month: null }) : { data: null };
  const { data: brand } = await supabaseAdmin().from('org_branding').select('brand_color, text_on_brand, email_footer, logo_sha256').eq('org_id', ws.orgId).maybeSingle();
  return (
    <>
    {usage ? (
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="usage-heading">
        <p className="text-sm text-ink-muted">{ws.name}</p>
        <h2 id="usage-heading" className="mb-1 mt-1 text-base font-medium text-ink">
          Plan and usage: {(usage as Usage).plan.name} plan, {monthInWords((usage as Usage).month)}
        </h2>
        <p className="mb-4 text-sm text-ink-muted">Documents, people and API requests count this month so far (UTC); the rest is as it is now. Each person&apos;s daily sending limits apply as well.</p>
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2" data-testid="usage">
          {usageLines(usage as Usage).map((l) => (
            <div key={l.label} className="flex justify-between gap-3 border-t border-hairline py-2">
              <dt className="text-sm text-ink-body">{l.label}</dt>
              <dd className="text-sm font-medium text-ink">{l.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    ) : null}
    <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="retention-heading">
      <p className="text-sm text-ink-muted">{ws.name}</p>
      <h2 id="retention-heading" className="mb-3 mt-1 text-base font-medium text-ink">How long finished documents are kept</h2>
      <RetentionForm orgId={ws.orgId} years={Number(controls?.retention_years ?? 7)} owner={ws.role === 'owner'} />
    </section>
    <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="branding-heading">
      <p className="text-sm text-ink-muted">{ws.name}</p>
      <h2 id="branding-heading" className="mb-1 mt-1 text-base font-medium text-ink">Branding</h2>
      <p className="mb-4 text-sm text-ink-muted">Your logo, name and colour appear above the signing page and at the top of emails about this workspace&apos;s documents; the footer at the end of those emails. The signing area itself stays plain and high-contrast.</p>
      <BrandingForm
        orgId={ws.orgId}
        workspaceName={ws.name}
        canEdit={ws.role === 'owner' || ws.role === 'admin'}
        initial={
          brand
            ? { color: brand.brand_color as string, text: brand.text_on_brand as 'light' | 'dark', footer: (brand.email_footer as string | null) ?? '', logoUrl: brand.logo_sha256 ? `/api/brand/${ws.orgId}/logo?v=${(brand.logo_sha256 as string).slice(0, 16)}` : null, saved: true }
            : { color: '#2F5D50', text: 'light', footer: '', logoUrl: null, saved: false }
        }
      />
    </section>
    {ws.role === 'owner' || ws.role === 'admin' ? (
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="api-heading">
        <p className="text-sm text-ink-muted">{ws.name}</p>
        <h2 id="api-heading" className="mb-1 mt-1 text-base font-medium text-ink">API keys</h2>
        <p className="mb-4 text-sm text-ink-muted">For connecting another system. A key acts as the person who made it, with their permissions and daily limits, and stops working if they leave the workspace. Keep keys secret like passwords.</p>
        <ApiKeys orgId={ws.orgId} keys={(apiKeys ?? []) as ApiKeyRow[]} />
      </section>
    ) : null}
    {ws.role === 'owner' || ws.role === 'admin' ? (
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="webhooks-heading">
        <p className="text-sm text-ink-muted">{ws.name}</p>
        <h2 id="webhooks-heading" className="mb-1 mt-1 text-base font-medium text-ink">Webhooks</h2>
        <p className="mb-4 text-sm text-ink-muted">Have another system told straight away when a document is sent, signed, completed, declined, voided or expires. Every event is signed so the receiver can check it came from us.</p>
        <Link href="/app/settings/webhooks" className="inline-flex min-h-11 items-center rounded-pill border border-control-border bg-surface px-6 text-base font-medium text-ink hover:bg-surface-sand">
          Manage webhooks
        </Link>
      </section>
    ) : null}
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
