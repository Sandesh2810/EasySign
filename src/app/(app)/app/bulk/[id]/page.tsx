import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CancelBulkButton } from './cancel-button';

export const metadata: Metadata = { title: 'Bulk send' };

interface View {
  id: string;
  title: string;
  template_id: string | null;
  delivery: 'email' | 'link';
  status: 'active' | 'done' | 'cancelled';
  created_at: string;
  counts: Record<string, number> | null;
  next_at: string | null;
  items: { row_no: number; name: string; email: string; status: string; reason: string | null; envelope_id: string | null; not_before: string }[];
}

const STATUS: Record<string, string> = { pending: 'Waiting to be sent', sent: 'Sent', failed: 'Not sent', invalid: 'Not sent (problem in the file)', cancelled: 'Cancelled' };

export default function BulkBatchPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
      <Batch params={params} />
    </Suspense>
  );
}

async function Batch({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const user = await requireUser(`/app/bulk/${raw}`);
  const id = z.uuid().safeParse(raw);
  if (!id.success) notFound();
  const { data, error } = await supabaseAdmin().rpc('bulk_batch_view', { p_actor: user.id, p_batch_id: id.data });
  if (error || !data) notFound();
  const b = data as View;
  const c = b.counts ?? {};
  const n = (k: string) => c[k] ?? 0;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href="/app/templates">Templates</Link> / Bulk send
        </p>
        <h1 className="mt-1 text-2xl font-medium text-ink">Bulk send: {b.title}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Started {b.created_at.slice(0, 16).replace('T', ' ')} UTC · {b.delivery === 'email' ? 'by email' : 'you share the links'} ·{' '}
          {b.status === 'active' ? 'in progress' : b.status === 'done' ? 'finished' : 'cancelled'}
        </p>
      </div>
      <section className="rounded-lg bg-surface p-6 shadow-soft">
        <h2 className="sr-only">Summary</h2>
        <dl className="grid grid-cols-2 gap-3 text-base sm:grid-cols-5">
          {[
            ['Sent', n('sent')],
            ['Waiting', n('pending')],
            ['Not sent', n('failed')],
            ['Problem in the file', n('invalid')],
            ['Cancelled', n('cancelled')],
          ].map(([label, v]) => (
            <div key={label as string}>
              <dt className="text-sm text-ink-muted">{label}</dt>
              <dd className="text-2xl text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        {b.status === 'active' && n('pending') > 0 && b.next_at ? (
          <p className="mt-4 text-sm text-ink-body">
            The next ones go out {new Date(b.next_at) <= new Date() ? 'within a few minutes' : `after ${b.next_at.slice(0, 16).replace('T', ' ')} UTC (the daily email allowance)`}.
            The background worker sends them; you can close this page.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <a href={`/api/bulk/${b.id}/report`} className="inline-flex min-h-11 items-center rounded-pill border border-control-border px-5 text-base text-ink no-underline hover:bg-surface-sand">
            Download the report (CSV)
          </a>
          {b.status === 'active' ? <CancelBulkButton batchId={b.id} /> : null}
        </div>
      </section>
      <section className="rounded-lg bg-surface p-6 shadow-soft">
        <h2 className="mb-3 text-base font-medium text-ink">Every row</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-ink-muted">
                <th className="py-1 pr-3 font-medium">Row</th>
                <th className="py-1 pr-3 font-medium">Name</th>
                <th className="py-1 pr-3 font-medium">Email</th>
                <th className="py-1 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {b.items.map((i) => (
                <tr key={i.row_no} className="border-t border-hairline align-top text-ink">
                  <td className="py-1 pr-3">{i.row_no}</td>
                  <td className="py-1 pr-3">{i.name}</td>
                  <td className="py-1 pr-3 break-all">{i.email}</td>
                  <td className="py-1 pr-3">
                    {i.envelope_id && i.status !== 'cancelled' ? <Link href={`/app/envelopes/${i.envelope_id}`}>{STATUS[i.status] ?? i.status}</Link> : (STATUS[i.status] ?? i.status)}
                    {i.reason ? <span className="block text-ink-muted">{i.reason}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
