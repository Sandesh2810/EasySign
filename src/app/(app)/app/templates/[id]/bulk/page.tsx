import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { allowanceFor, DEFAULT_BUDGET, emptyState } from '@/lib/email-budget';
import { loadBudget } from '@/lib/email-budget-state';
import type { TemplateNamedField } from '@/lib/bulk';
import type { FieldOptions, FieldType } from '@/lib/fields';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { BulkUpload } from './bulk-upload';

export const metadata: Metadata = { title: 'Bulk send' };

export default function BulkPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
      <Bulk params={params} />
    </Suspense>
  );
}

async function Bulk({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const user = await requireUser(`/app/templates/${raw}/bulk`);
  const id = z.uuid().safeParse(raw);
  if (!id.success) notFound();
  const admin = supabaseAdmin();
  const { data: tpl, error } = await admin.rpc('template_get', { p_actor: user.id, p_template_id: id.data });
  if (error || !tpl) notFound();
  const t = tpl as { id: string; name: string; roles: { id: string; label: string; role: string }[] };
  const usable = t.roles.length === 1 && ['signer', 'approver'].includes(t.roles[0].role);
  // access was checked above (template_get); the named fields come with their settings for checking values
  const { data: rows } = usable ? await admin.from('template_fields').select('type, options').eq('template_id', t.id) : { data: [] };
  const fields: TemplateNamedField[] = (rows ?? [])
    .filter((f) => typeof (f.options as FieldOptions | null)?.name === 'string')
    .map((f) => ({ name: (f.options as FieldOptions).name!, type: f.type as FieldType, options: (f.options ?? {}) as FieldOptions }));
  // how many request emails can go out: what is left today, and a whole day's worth (AT4.2: spread over days)
  const snap = await loadBudget(user.id);
  const opts = { userSentToday: snap.userSentToday, restrictedSender: snap.restricted };
  const leftToday = allowanceFor('P0_REQUEST', snap.state, DEFAULT_BUDGET, opts).left;
  const perFullDay = allowanceFor('P0_REQUEST', emptyState(snap.state.daysLeftInMonth), DEFAULT_BUDGET, { ...opts, userSentToday: 0 }).left;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href={`/app/templates/${t.id}`}>{t.name}</Link> / Bulk send
        </p>
        <h1 className="mt-1 text-2xl font-medium text-ink">Send &ldquo;{t.name}&rdquo; to many people</h1>
      </div>
      {usable ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <BulkUpload templateId={t.id} roleLabel={t.roles[0].label} fields={fields} leftToday={leftToday} perFullDay={perFullDay} />
        </section>
      ) : (
        <p className="rounded-lg bg-surface p-6 text-base text-ink-body shadow-soft">
          Bulk send works with a template that has exactly one person, who signs or approves. This template has {t.roles.length === 1 ? 'one person who only gets a copy' : `${t.roles.length} people`}.
        </p>
      )}
    </div>
  );
}
