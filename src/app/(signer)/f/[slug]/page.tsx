import type { Metadata } from 'next';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { signerI18n } from '@/i18n/server';
import { Text } from '../../text';
import { env } from '@/lib/env';
import { formToken, SLUG } from '@/lib/power-form';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { PublicForm } from './public-form';
import { BrandBand } from '@/components/brand-band';
import { loadBrand } from '@/lib/branding-store';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await signerI18n();
  return { title: t('form.meta'), robots: { index: false, follow: false } };
}

// D-87 (AT4.3): a public link to a one-person template. Anyone with the link fills in their name and email and signs
// their own copy at once. The page says plainly who the form is from.
export default function PowerFormPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={<p className="mx-auto max-w-xl px-4 py-16 text-ink-muted"><Text k="form.loading" /></p>}>
      <FormView params={params} />
    </Suspense>
  );
}

async function FormView({ params }: { params: Promise<{ slug: string }> }) {
  await connection(); // per request: the load time is signed into the form
  const { slug } = await params;
  const { t } = await signerI18n();
  const { data } = SLUG.test(slug) ? await supabaseAdmin().rpc('power_form_public', { p_slug: slug }) : { data: null };
  const form = data as { title: string; owner_name: string; org_name: string | null; email_check: boolean } | null;
  if (!form) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-2xl font-medium text-ink">{t('form.naTitle')}</h1>
        <p className="mt-3 text-base text-ink-body">{t('form.naBody')}</p>
      </div>
    );
  }
  // D-88: the workspace's branding above the form
  const { data: owner } = await supabaseAdmin().from('power_forms').select('org_id').eq('slug', slug).maybeSingle();
  const brand = owner ? await loadBrand(owner.org_id as string) : null;
  return (
    <>
    {brand ? <BrandBand brand={brand} /> : null}
    <div className="mx-auto max-w-xl px-4 py-12">
      <p className="text-sm text-ink-muted">
        {t('form.from', { owner: form.owner_name })}
        {form.org_name && form.org_name !== form.owner_name ? ` · ${form.org_name}` : ''}
      </p>
      <h1 className="mt-1 text-2xl font-medium text-ink [overflow-wrap:anywhere]">{form.title}</h1>
      <p className="mt-3 text-base text-ink-body">
        {t('form.intro')}
        {form.email_check ? ` ${t('form.introCheck')}` : ''}
      </p>
      <PublicForm slug={slug} token={formToken(env.sessionCookieKey(), slug)} />
      <p className="mt-8 text-sm text-ink-muted">
        {t('form.warning', { owner: form.owner_name })}
      </p>
    </div>
    </>
  );
}
