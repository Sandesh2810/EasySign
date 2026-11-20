import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace, canSend } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Templates' };

type Row = { id: string; name: string; shared: boolean; mine: boolean; can_edit: boolean; roles: string | null; fields: number; locked: number; created_by_name: string };

export default function TemplatesPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="text-2xl font-medium text-ink">Templates</h1>
      <Suspense fallback={<p className="text-ink-muted">Loading templates…</p>}>
        <Templates />
      </Suspense>
    </div>
  );
}

async function Templates() {
  const user = await requireUser('/app/templates');
  const { current: ws } = await activeWorkspace(user.id);
  if (!canSend(ws.role)) return <p className="text-base text-ink-body">Viewers do not use templates. Ask the owner if you need to send documents.</p>;
  const { data, error } = await supabaseAdmin().rpc('template_list', { p_actor: user.id, p_org: ws.orgId });
  const list = (data ?? []) as Row[];
  return (
    <>
      <p className="text-base text-ink-body">
        A template keeps a document and its fields with roles (such as “Tenant”) instead of people. To make one, open any document and use “Save as template”.
      </p>
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="templates-heading">
        <h2 id="templates-heading" className="mb-4 text-base font-medium text-ink">
          {ws.name}
        </h2>
        {error ? (
          <p role="alert" className="text-sm text-ink">
            The templates could not be loaded. Reload the page.
          </p>
        ) : list.length === 0 ? (
          <p className="text-sm text-ink-muted">No templates yet.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link href={`/app/templates/${t.id}`} className="text-base [overflow-wrap:anywhere]">
                    {t.name}
                  </Link>
                  <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
                    {t.roles ?? 'No roles'} · {t.fields} field{t.fields === 1 ? '' : 's'}
                    {t.locked ? ` (${t.locked} locked)` : ''} · {t.shared ? 'shared with the team' : 'only you'}
                    {t.mine ? '' : t.created_by_name ? ` · by ${t.created_by_name}` : ''}
                  </p>
                </div>
                <Link href={`/app/templates/${t.id}`} className="inline-flex min-h-11 items-center rounded-pill border border-control-border px-5 text-base text-ink no-underline">
                  {t.can_edit ? 'Use or edit' : 'Use'}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
