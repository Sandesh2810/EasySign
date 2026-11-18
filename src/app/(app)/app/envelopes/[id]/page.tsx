import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui';
import { StatusChip } from '@/components/status-chip';
import type { FieldType } from '@/lib/fields';
import { deleteDraftAction } from '../actions';
import { FieldEditor, type EditorField } from './field-editor';
import { RecipientForm } from './recipient-form';

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
  const [{ data: env }, { data: docs }, { data: recipients }, { data: fields }] = await Promise.all([
    supabase.from('envelopes').select('id, title, status, public_code, created_at').eq('id', id.data).maybeSingle(),
    supabase.from('envelope_documents').select('id, filename, page_count, size_bytes, sha256').eq('envelope_id', id.data).order('position'),
    supabase.from('recipients').select('id, name, email, role, status').eq('envelope_id', id.data).order('routing_order'),
    supabase.from('fields').select('id, type, page, x, y, w, h, required').eq('envelope_id', id.data),
  ]);
  if (!env) notFound(); // row-level security: someone else's document does not exist for this user
  const doc = docs?.[0];
  const recipient = recipients?.[0] ?? null;
  const isDraft = env.status === 'draft';
  const initialFields: EditorField[] = (fields ?? []).map((f) => ({
    key: f.id as string,
    type: f.type as FieldType,
    page: f.page as number,
    x: Number(f.x),
    y: Number(f.y),
    w: Number(f.w),
    h: Number(f.h),
    required: Boolean(f.required),
  }));

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
        <div className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-3 text-base font-medium text-ink">1. Who signs?</h2>
          {isDraft ? (
            <RecipientForm envelopeId={env.id} recipient={recipient ? { name: recipient.name, email: recipient.email } : null} />
          ) : recipient ? (
            <p className="text-sm text-ink-body">
              {recipient.name} · {recipient.email}
            </p>
          ) : (
            <p className="text-sm text-ink-muted">No signer.</p>
          )}
        </div>
        <div className="rounded-lg bg-surface p-6 shadow-soft lg:col-span-2">
          <h2 className="text-base font-medium text-ink">Original file</h2>
          {doc ? (
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-muted">File</dt>
              <dd className="truncate text-ink">{doc.filename}</dd>
              <dt className="text-ink-muted">Pages</dt>
              <dd className="text-ink">{doc.page_count}</dd>
              <dt className="text-ink-muted">Size</dt>
              <dd className="text-ink">{Math.max(1, Math.round(Number(doc.size_bytes) / 1024))} KB</dd>
              <dt className="text-ink-muted">SHA-256</dt>
              <dd className="break-all font-mono text-xs text-ink">{doc.sha256}</dd>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-ink-muted">No file is attached to this document.</p>
          )}
          {doc ? (
            <p className="mt-4 text-sm">
              <a href={`/api/envelopes/${env.id}/document`} target="_blank" rel="noopener">
                Open the original PDF in a new tab
              </a>
            </p>
          ) : null}
        </div>
      </section>

      {doc ? (
        <section>
          <h2 className="mb-3 text-base font-medium text-ink">2. Where do they sign?</h2>
          <FieldEditor
            key={recipient?.id ?? 'none'}
            envelopeId={env.id}
            documentId={doc.id}
            recipient={recipient ? { id: recipient.id, name: recipient.name } : null}
            initialFields={initialFields}
            readOnly={!isDraft}
          />
        </section>
      ) : null}

      {isDraft ? (
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
