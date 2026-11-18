import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui';
import { StatusChip } from '@/components/status-chip';
import { deleteDraftAction } from '../actions';

export const metadata: Metadata = { title: 'Document' };

export default function EnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading document…</p>}>
      <Envelope params={params} />
    </Suspense>
  );
}

async function Envelope({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  await requireUser(`/app/envelopes/${rawId}`);
  const id = z.uuid().safeParse(rawId);
  if (!id.success) notFound();

  const supabase = await createSupabaseServerClient();
  const [{ data: env }, { data: docs }, { data: recipients }] = await Promise.all([
    supabase.from('envelopes').select('id, title, status, public_code, created_at').eq('id', id.data).maybeSingle(),
    supabase.from('envelope_documents').select('id, filename, page_count, size_bytes, sha256').eq('envelope_id', id.data).order('position'),
    supabase.from('recipients').select('id, name, email, role, status').eq('envelope_id', id.data).order('routing_order'),
  ]);
  if (!env) notFound(); // row-level security: someone else's document does not exist for this user
  const doc = docs?.[0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href="/app">Dashboard</Link> / Document
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-4xl font-light italic text-ink">{env.title}</h1>
          <StatusChip status={env.status} />
        </div>
        <p className="mt-1 font-mono text-sm text-ink-muted">Verification code {env.public_code}</p>
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg bg-surface p-6 shadow-soft lg:col-span-2">
          <h2 className="text-base font-medium text-ink">Original file</h2>
          {doc ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-muted">File</dt>
              <dd className="text-ink">{doc.filename}</dd>
              <dt className="text-ink-muted">Pages</dt>
              <dd className="text-ink">{doc.page_count}</dd>
              <dt className="text-ink-muted">Size</dt>
              <dd className="text-ink">{(Number(doc.size_bytes) / 1024).toFixed(0)} KB</dd>
              <dt className="text-ink-muted">SHA-256</dt>
              <dd className="break-all font-mono text-xs text-ink">{doc.sha256}</dd>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-ink-muted">No file is attached to this document.</p>
          )}
          {doc ? (
            <p className="mt-4">
              <a href={`/api/envelopes/${env.id}/document`} target="_blank" rel="noopener">
                Open the original PDF
              </a>
            </p>
          ) : null}
        </div>
        <div className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="text-base font-medium text-ink">Recipients</h2>
          {recipients && recipients.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {recipients.map((r) => (
                <li key={r.id}>
                  <span className="text-ink">{r.name}</span> <span className="text-ink-muted">· {r.email}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-muted">None yet. Adding recipients and placing signature fields is the next step being built.</p>
          )}
        </div>
      </section>

      {env.status === 'draft' ? (
        <form action={deleteDraftAction}>
          <input type="hidden" name="envelope_id" value={env.id} />
          <Button type="submit" variant="outline">
            Delete this draft
          </Button>
        </form>
      ) : null}
    </div>
  );
}
