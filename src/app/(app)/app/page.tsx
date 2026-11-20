import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Notice } from '@/components/ui';
import { StatusChip } from '@/components/status-chip';
import { EmailMeter } from '@/components/email-meter';
import { NO_PHI_NOTICE } from '@/config/brand';
import { activeWorkspace, canSend, ROLE_LABEL } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Dashboard' };

const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'action', label: 'Waiting for you' },
  { id: 'waiting', label: 'Waiting for others' },
  { id: 'expiring', label: 'Expiring soon' },
  { id: 'draft', label: 'Drafts' },
  { id: 'completed', label: 'Completed' },
  { id: 'closed', label: 'Declined, cancelled or expired' },
] as const;
type View = (typeof VIEWS)[number]['id'];
const PAGE = 50;

interface Row {
  id: string;
  title: string;
  status: string;
  public_code: string;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  folder_name: string | null;
  people: string | null;
  total_count: number;
}

type Search = { q?: string; view?: string; folder?: string; page?: string };

export default function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading your dashboard…</p>}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}

function hrefFor(base: { q: string; view: View; folder: string }, change: Partial<{ q: string; view: View; folder: string; page: number }>) {
  const next = { ...base, page: 1, ...change };
  const p = new URLSearchParams();
  if (next.q) p.set('q', next.q);
  if (next.view !== 'all') p.set('view', next.view);
  if (next.folder) p.set('folder', next.folder);
  if (next.page > 1) p.set('page', String(next.page));
  const s = p.toString();
  return s ? `/app?${s}` : '/app';
}

async function Dashboard({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser('/app');
  const sp = await searchParams;
  const q = String(sp.q ?? '').trim().slice(0, 100);
  const view: View = (VIEWS.some((v) => v.id === sp.view) ? sp.view : 'all') as View;
  const page = Math.max(1, Math.min(200, Number.parseInt(String(sp.page ?? '1'), 10) || 1));
  const supabase = await createSupabaseServerClient();
  const { current: ws, all: workspaces } = await activeWorkspace(user.id);
  const [{ data: profile }, { data: controls }, { data: folders }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
    supabase.from('account_controls').select('approved, trust_level').eq('user_id', user.id).maybeSingle(),
    supabase.from('folders').select('id, name').eq('org_id', ws.orgId).order('name'),
  ]);
  const folder = (folders ?? []).some((f) => f.id === sp.folder) ? String(sp.folder) : '';
  // search_envelopes looks only in this workspace and applies the team rules itself (a member sees only their own documents)
  const { data, error } = await supabaseAdmin().rpc('search_envelopes', { p_actor: user.id, p_org_id: ws.orgId, p_query: q, p_view: view, p_folder_id: folder || null, p_limit: PAGE, p_offset: (page - 1) * PAGE });
  const list = (data ?? []) as Row[];
  const total = Number(list[0]?.total_count ?? 0);
  const base = { q, view, folder };

  const org = { name: workspaces.length > 1 ? `${ws.name} · ${ROLE_LABEL[ws.role]}` : ws.name };
  const filtered = q !== '' || view !== 'all' || folder !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-widest text-ink-muted">{org?.name ?? 'Dashboard'}</p>
          <h1 className="mt-1 font-serif text-4xl font-light italic text-ink">Hello{profile?.display_name ? `, ${profile.display_name}` : ''}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/folders" className="inline-flex min-h-11 items-center rounded-pill border border-control-border px-5 text-base text-ink no-underline">
            Folders
          </Link>
          {canSend(ws.role) ? (
            <Link href="/app/new" className="inline-flex min-h-11 items-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline">
              New document
            </Link>
          ) : null}
        </div>
      </div>
      {/* requireUser already sent anyone with an authenticator to the code page, so aal1 here means "not set up" */}
      {user.aal !== 'aal2' ? (
        <p className="rounded-md bg-surface px-4 py-3 text-sm text-ink-body shadow-soft">
          Protect your account: switch on two-step sign-in, so a stolen password alone cannot open it.{' '}
          <Link href="/app/account/security">Set it up</Link>
        </p>
      ) : null}

      {controls && !controls.approved ? (
        <Notice tone="info">
          Your account is waiting for approval. You can prepare documents and sign them yourself now; sending to other people unlocks once an administrator approves your account.
        </Notice>
      ) : null}
      {controls?.trust_level === 'suspended' ? <Notice tone="danger">This account is suspended. Contact the administrator.</Notice> : null}

      <EmailMeter userId={user.id} />

      <section className="rounded-lg bg-surface shadow-soft" aria-labelledby="documents-heading">
        <div className="flex flex-col gap-4 border-b border-hairline px-6 py-4">
          <h2 id="documents-heading" className="text-base font-medium text-ink">
            Documents
          </h2>
          <form action="/app" method="get" role="search" className="flex flex-wrap items-end gap-3">
            {view !== 'all' ? <input type="hidden" name="view" value={view} /> : null}
            <div className="flex min-w-0 flex-1 basis-full flex-col gap-1.5 sm:basis-auto">
              <label htmlFor="doc-search" className="text-sm font-medium text-ink">
                Search
              </label>
              <input
                id="doc-search"
                name="q"
                type="search"
                defaultValue={q}
                maxLength={100}
                placeholder="Title, verification code, or a person's name or email"
                className="min-h-11 w-full rounded-sm border border-control-border bg-surface px-3 text-base text-ink placeholder:text-ink-muted"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="doc-folder" className="text-sm font-medium text-ink">
                Folder
              </label>
              <select id="doc-folder" name="folder" defaultValue={folder} className="min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink">
                <option value="">All folders</option>
                {(folders ?? []).map((f) => (
                  <option key={f.id as string} value={f.id as string}>
                    {f.name as string}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="min-h-11 rounded-pill bg-ink px-5 text-base font-medium text-on-ink">
              Search
            </button>
          </form>
          <nav aria-label="Show documents" className="flex flex-wrap gap-2">
            {VIEWS.map((v) => (
              <Link
                key={v.id}
                href={hrefFor(base, { view: v.id })}
                aria-current={v.id === view ? 'page' : undefined}
                className={`inline-flex min-h-10 items-center rounded-pill border px-4 text-sm no-underline ${v.id === view ? 'border-ink bg-ink text-on-ink' : 'border-control-border text-ink'}`}
              >
                {v.label}
              </Link>
            ))}
          </nav>
        </div>
        {error ? (
          <p className="px-6 py-10 text-center text-ink-body">The documents could not be loaded. Reload the page to try again.</p>
        ) : list.length === 0 ? (
          <div className="px-6 py-10 text-center">
            {filtered ? (
              <>
                <p className="text-lg text-ink">Nothing matches</p>
                <p className="mt-4">
                  <Link href="/app">Show all documents</Link>
                </p>
              </>
            ) : (
              <>
                <p className="text-lg text-ink">No documents yet</p>
                <p className="mt-1 text-sm text-ink-muted">Upload a PDF or a photo of a document to get started.</p>
                <p className="mt-4">
                  <Link href="/app/new">Upload your first document</Link>
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="px-6 pt-3 text-sm text-ink-muted" role="status">
              {total === 1 ? '1 document' : `${total} documents`}
              {total > PAGE ? `, showing ${(page - 1) * PAGE + 1} to ${Math.min(total, page * PAGE)}` : ''}
            </p>
            <ul className="divide-y divide-hairline">
              {list.map((e) => (
                <li key={e.id}>
                  <Link href={`/app/envelopes/${e.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-6 py-3 text-ink no-underline hover:bg-surface-sand">
                    <span className="min-w-0">
                      {/* Wraps instead of cutting off, so nothing is lost on a narrow screen (WCAG 1.4.10, slice 9). */}
                      <span className="block text-base [overflow-wrap:anywhere]">{e.title}</span>
                      <span className="block text-sm text-ink-muted [overflow-wrap:anywhere]">
                        {e.people ? `${e.people} · ` : ''}
                        {e.folder_name ? `${e.folder_name} · ` : ''}
                        <span className="font-mono text-xs break-all">{e.public_code}</span>
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-sm text-ink-muted">{(e.completed_at ?? e.created_at).slice(0, 10)}</span>
                      <StatusChip status={e.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {total > PAGE ? (
              <nav aria-label="Pages" className="flex justify-between border-t border-hairline px-6 py-3 text-sm">
                {page > 1 ? <Link href={hrefFor(base, { page: page - 1 })}>Previous {PAGE}</Link> : <span />}
                {page * PAGE < total ? <Link href={hrefFor(base, { page: page + 1 })}>Next {PAGE}</Link> : <span />}
              </nav>
            ) : null}
          </>
        )}
      </section>

      <p className="text-sm text-ink-muted">{NO_PHI_NOTICE}</p>
    </div>
  );
}
