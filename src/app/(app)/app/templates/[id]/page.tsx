import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { FIELD_LABEL, type FieldType } from '@/lib/fields';
import { DeleteTemplateForm, EditTemplateForm, UseTemplateForm } from '../template-forms';
import { env } from '@/lib/env';
import { PowerForms, type PowerFormRow } from './power-forms';

export const metadata: Metadata = { title: 'Template' };

type Template = {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  access: 'edit' | 'use';
  page_count: number;
  roles: { id: string; label: string; role: string }[];
  fields: { id: string; role_id: string; type: FieldType; page: number; locked: boolean }[];
};

export default function TemplatePage({ params }: PageProps<'/app/templates/[id]'>) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <p className="text-sm">
        <Link href="/app/templates">All templates</Link>
      </p>
      <Suspense fallback={<p className="text-ink-muted">Loading the template…</p>}>
        <TemplateView params={params} />
      </Suspense>
    </div>
  );
}

async function TemplateView({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser('/app/templates');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  // template_get answers only if this person may use the template (it checks the role and the workspace itself)
  const { data, error } = await supabaseAdmin().rpc('template_get', { p_actor: user.id, p_template_id: id.data });
  if (error || !data) notFound();
  const t = data as Template;
  const roleLabel = new Map(t.roles.map((r) => [r.id, r.label]));
  const { data: formData } = t.roles.length === 1 ? await supabaseAdmin().rpc('power_form_list', { p_actor: user.id, p_template_id: t.id }) : { data: [] };
  const forms = (formData ?? []) as PowerFormRow[];
  return (
    <>
      <h1 className="text-2xl font-medium text-ink [overflow-wrap:anywhere]">{t.name}</h1>
      <p className="text-base text-ink-body">
        {t.page_count} page{t.page_count === 1 ? '' : 's'} · {t.roles.length} role{t.roles.length === 1 ? '' : 's'} · {t.fields.length} field
        {t.fields.length === 1 ? '' : 's'} · {t.shared ? 'shared with the team' : 'only you'}
      </p>

      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="use-heading">
        <h2 id="use-heading" className="mb-1 text-base font-medium text-ink">
          Use this template
        </h2>
        <p className="mb-4 text-sm text-ink-muted">Name a person for each role. You get a draft to check and send; locked fields stay where they are.</p>
        <UseTemplateForm templateId={t.id} name={t.name} roles={t.roles.map((r) => ({ id: r.id, label: r.label }))} />
        {t.roles.length === 1 ? (
          // D-85: one document per row of a CSV file
          <p className="mt-4 text-sm text-ink-body">
            Sending this to many people? <Link href={`/app/templates/${t.id}/bulk`}>Bulk send from a CSV file</Link>.
          </p>
        ) : null}
      </section>

      {t.roles.length === 1 && t.roles[0].role === 'signer' ? (
        // D-87: public forms (PowerForms)
        <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="forms-heading">
          <h2 id="forms-heading" className="mb-1 text-base font-medium text-ink">
            Public form
          </h2>
          <p className="mb-4 text-sm text-ink-muted">
            Share a link anyone can use: they enter their name and email, and get their own copy of this document to sign at once. Each one counts towards your daily sending limits.
          </p>
          <PowerForms templateId={t.id} templateName={t.name} appUrl={env.appUrl()} forms={forms} />
        </section>
      ) : null}

      {t.access === 'edit' ? (
        <>
          <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="edit-heading">
            <h2 id="edit-heading" className="mb-4 text-base font-medium text-ink">
              Edit the template
            </h2>
            <EditTemplateForm
              templateId={t.id}
              name={t.name}
              shared={t.shared}
              roles={t.roles}
              fields={t.fields.map((f) => ({ id: f.id, label: `${FIELD_LABEL[f.type] ?? f.type} · ${roleLabel.get(f.role_id) ?? ''} · page ${f.page}`, locked: f.locked }))}
            />
            <p className="mt-4 text-sm text-ink-muted">To change where fields are, start a draft from this template, adjust it, and save it as a new template.</p>
          </section>
          <DeleteTemplateForm templateId={t.id} name={t.name} />
        </>
      ) : null}
    </>
  );
}
