import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Button, Notice } from '@/components/ui';
import { StatusChip } from '@/components/status-chip';
import type { FieldType } from '@/lib/fields';
import { progressLabel, ROLE_LABEL } from '@/lib/recipient-labels';
import type { RecipientStatus, Role, RoutingMode } from '@/lib/routing';
import { deleteDraftAction } from '../actions';
import { FieldEditor, type EditorField } from './field-editor';
import { RecipientsEditor, type EditableRecipient } from './recipients-editor';
import { SendPanel, SigningLinkPanel } from './send-panel';

export const metadata: Metadata = { title: 'Document' };

export default function EnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading document…</p>}>
      <Envelope params={params} />
    </Suspense>
  );
}

interface RecipientRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: RecipientStatus;
  is_sender: boolean;
  routing_order: number;
  decline_reason: string | null;
}

async function Envelope({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const user = await requireUser(`/app/envelopes/${rawId}`);
  const id = z.uuid().safeParse(rawId);
  if (!id.success) notFound();

  const supabase = await createSupabaseServerClient();
  const [{ data: env }, { data: docs }, { data: recipientRows }, { data: fields }, { data: profile }] = await Promise.all([
    supabase.from('envelopes').select('id, title, status, public_code, created_at, self_sign, final_sha256, completed_at, routing_mode').eq('id', id.data).maybeSingle(),
    supabase.from('envelope_documents').select('id, filename, page_count, size_bytes, sha256').eq('envelope_id', id.data).order('position'),
    supabase.from('recipients').select('id, name, email, role, status, is_sender, routing_order, decline_reason').eq('envelope_id', id.data).order('routing_order').order('created_at'),
    supabase.from('fields').select('id, recipient_id, type, page, x, y, w, h, required').eq('envelope_id', id.data),
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
  ]);
  if (!env) notFound(); // row-level security: someone else's document does not exist for this user
  const doc = docs?.[0];
  const recipients = (recipientRows ?? []) as RecipientRow[];
  const signers = recipients.filter((r) => r.role === 'signer' || r.role === 'in_person').map((r) => ({ id: r.id, name: r.name }));
  const isDraft = env.status === 'draft';
  const isOpen = env.status === 'sent' || env.status === 'in_progress';
  const selfSign = isDraft ? recipients.length === 1 && recipients[0].is_sender && recipients[0].role === 'signer' : Boolean(env.self_sign);
  const decliner = recipients.find((r) => r.status === 'declined');
  const initialFields: EditorField[] = (fields ?? []).map((f) => ({
    key: f.id as string,
    recipientId: f.recipient_id as string,
    type: f.type as FieldType,
    page: f.page as number,
    x: Number(f.x),
    y: Number(f.y),
    w: Number(f.w),
    h: Number(f.h),
    required: Boolean(f.required),
  }));
  const editable: EditableRecipient[] = recipients
    .filter((r) => r.role !== 'in_person')
    .map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role as EditableRecipient['role'], order: r.routing_order }));

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

      {env.status === 'declined' && decliner ? (
        <Notice tone="danger">
          {decliner.name} declined this document. {decliner.decline_reason ? `Their reason: “${decliner.decline_reason}”` : 'They gave no reason.'} It has been stopped for everyone and every signing link is switched off. To try again, create a new document.
        </Notice>
      ) : null}

      <section className="rounded-lg bg-surface p-6 shadow-soft">
        <h2 className="mb-3 text-base font-medium text-ink">{isDraft ? '1. Who is involved?' : 'People'}</h2>
        {isDraft ? (
          <RecipientsEditor
            key={`${env.routing_mode}:${recipients.map((r) => `${r.id}${r.role}${r.routing_order}`).join(',')}`}
            envelopeId={env.id}
            initial={editable}
            initialMode={env.routing_mode as RoutingMode}
            me={{ name: (profile?.display_name as string | undefined) || 'Me', email: user.email ?? '' }}
          />
        ) : recipients.length === 0 ? (
          <p className="text-sm text-ink-muted">Nobody was added.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-hairline">
            {recipients.map((r) => (
              <li key={r.id} className="grid gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
                <span className="text-ink-muted">{r.role === 'cc' ? 'End' : `Turn ${r.routing_order}`}</span>
                <span className="min-w-0">
                  <span className="block truncate text-ink">{r.name}</span>
                  <span className="block truncate text-ink-muted">{r.email}</span>
                </span>
                <span className="text-ink-body">{ROLE_LABEL[r.role]}</span>
                <span className="font-medium text-ink">{progressLabel(r.role, r.status)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="rounded-lg bg-surface p-6 shadow-soft">
        <h2 className="text-base font-medium text-ink">Original file</h2>
        {doc ? (
          <>
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
            <p className="mt-4 text-sm">
              <a href={`/api/envelopes/${env.id}/document`} target="_blank" rel="noopener">
                Open the original PDF in a new tab
              </a>
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">No file is attached to this document.</p>
        )}
      </section>

      {doc ? (
        <section>
          <h2 className="mb-3 text-base font-medium text-ink">{isDraft ? '2. Where do they sign?' : 'Fields'}</h2>
          <FieldEditor key={signers.map((s) => s.id).join(',') || 'none'} envelopeId={env.id} documentId={doc.id} signers={signers} initialFields={initialFields} readOnly={!isDraft} />
        </section>
      ) : null}

      {doc && (isDraft || isOpen) ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-3 text-base font-medium text-ink">{isDraft ? '3. Send' : 'Signing links'}</h2>
          {isDraft ? <SendPanel envelopeId={env.id} selfSign={selfSign} hasSigner={signers.length > 0} /> : <SigningLinkPanel envelopeId={env.id} selfSign={selfSign} />}
        </section>
      ) : null}

      {env.status === 'completed' ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-3 text-base font-medium text-ink">Completed</h2>
          <p className="text-sm text-ink-body">Everyone has finished. The sealed file and its certificate are ready.</p>
          <p className="mt-2 break-all font-mono text-xs text-ink-muted">SHA-256 of the sealed file: {env.final_sha256}</p>
          <p className="mt-4 flex flex-wrap gap-4 text-sm">
            <a href={`/api/envelopes/${env.id}/sealed`}>Download the signed PDF</a>
            <a href={`/api/envelopes/${env.id}/sealed?part=certificate`}>Download the certificate</a>
          </p>
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
