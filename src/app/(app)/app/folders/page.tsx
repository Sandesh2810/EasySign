import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AddRuleForm, CreateFolderForm, DeleteFolderForm, DeleteRuleForm } from './folder-forms';

export const metadata: Metadata = { title: 'Folders' };

export default function FoldersPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading folders…</p>}>
      <Folders />
    </Suspense>
  );
}

// Reads through the user's own session: row-level security shows only this workspace's folders and rules.
async function Folders() {
  await requireUser('/app/folders');
  const supabase = await createSupabaseServerClient();
  const [{ data: folders }, { data: rules }, { data: completed }] = await Promise.all([
    supabase.from('folders').select('id, name').order('name'),
    supabase.from('filing_rules').select('id, folder_id, title_contains, created_at').order('position').order('created_at'),
    supabase.from('envelopes').select('folder_id').eq('status', 'completed').not('folder_id', 'is', null).limit(5000),
  ]);
  const list = (folders ?? []).map((f) => ({ id: f.id as string, name: f.name as string }));
  const done = new Map<string, number>();
  for (const e of completed ?? []) done.set(e.folder_id as string, (done.get(e.folder_id as string) ?? 0) + 1);
  const folderName = new Map(list.map((f) => [f.id, f.name]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href="/app">Dashboard</Link> / Folders
        </p>
        <h1 className="mt-2 font-serif text-4xl font-light italic text-ink">Folders</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-body">
          Every document can sit in one folder. A completed document goes to the folder chosen when it was sent, unless a filing rule below says otherwise. You can download all completed documents of a
          folder at once as a ZIP file (each with its signed PDF and its certificate).
        </p>
      </div>

      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="folders-heading">
        <h2 id="folders-heading" className="text-base font-medium text-ink">
          Your folders
        </h2>
        <ul className="mt-3 flex flex-col divide-y divide-hairline">
          {list.map((f) => {
            const n = done.get(f.id) ?? 0;
            return (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <Link href={`/app?folder=${f.id}`} className="text-base text-ink">
                    {f.name}
                  </Link>
                  <span className="block text-sm text-ink-muted">{n === 1 ? '1 completed document' : `${n} completed documents`}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {n > 0 ? (
                    <a
                      href={`/api/folders/${f.id}/zip`}
                      className="inline-flex min-h-10 items-center rounded-pill border border-control-border px-4 text-sm text-ink no-underline"
                      aria-label={`Download the completed documents of ${f.name} as a ZIP file`}
                    >
                      Download ZIP
                    </a>
                  ) : null}
                  <DeleteFolderForm folderId={f.id} name={f.name} />
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 border-t border-hairline pt-4">
          <CreateFolderForm />
        </div>
      </section>

      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="rules-heading">
        <h2 id="rules-heading" className="text-base font-medium text-ink">
          Filing rules
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-body">
          When a document is completed, the first rule whose words appear in its title (capital letters do not matter) moves it into that rule’s folder. Rules apply from the moment you add them; they do not
          move documents completed earlier.
        </p>
        {(rules ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No rules yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col divide-y divide-hairline">
            {(rules ?? []).map((r) => {
              const label = `title contains “${r.title_contains}”, file in ${folderName.get(r.folder_id as string) ?? 'a folder'}`;
              return (
                <li key={r.id as string} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm text-ink">
                  <span>
                    When the title contains <strong className="font-medium">“{r.title_contains as string}”</strong>, file it in{' '}
                    <strong className="font-medium">{folderName.get(r.folder_id as string) ?? '(a folder)'}</strong>
                  </span>
                  <DeleteRuleForm ruleId={r.id as string} label={label} />
                </li>
              );
            })}
          </ol>
        )}
        {list.length > 0 ? (
          <div className="mt-4 border-t border-hairline pt-4">
            <AddRuleForm folders={list} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
