// D-93: Reports. What happened to the workspace's documents in a period: in total, by person and by template.
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Button, Notice } from '@/components/ui';
import { requireUser } from '@/lib/auth/session';
import { hoursInWords, NO_TEMPLATE, parsePeriod, type Report, type ReportNumbers, type ReportRow } from '@/lib/reports';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Reports' };

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const TILES: { key: keyof Omit<ReportNumbers, 'avg_hours_to_complete'>; label: string }[] = [
  { key: 'sent', label: 'Sent' },
  { key: 'completed', label: 'Completed' },
  { key: 'declined', label: 'Declined' },
  { key: 'voided', label: 'Voided' },
  { key: 'expired', label: 'Expired' },
];

function Breakdown({ id, caption, first, rows }: { id: string; caption: string; first: string; rows: ReportRow[] }) {
  return (
    <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby={id}>
      <h2 id={id} className="mb-3 text-base font-medium text-ink">
        {caption}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing happened in this period.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline" aria-label={caption}>
          {rows.map((r) => (
            <li key={r.id ?? 'none'} className="py-3">
              <p className="text-base font-medium text-ink [overflow-wrap:anywhere]">{r.name ?? (first === 'Template' ? NO_TEMPLATE : 'Unknown')}</p>
              <p className="text-sm text-ink-body">
                {r.sent} sent · {r.completed} completed · {r.declined} declined · {r.voided} voided · {r.expired} expired · average to complete {hoursInWords(r.avg_hours_to_complete)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser('/app/reports');
  const { current: ws } = await activeWorkspace(user.id);
  const sp = await searchParams;
  const period = parsePeriod(sp.from, sp.to);
  let report: Report | null = null;
  if (period.ok) {
    const { data } = await supabaseAdmin().rpc('report_summary', { p_actor: user.id, p_org: ws.orgId, p_from: period.from, p_to: period.to });
    report = (data as Report | null) ?? null;
  }
  const csvHref = `/api/reports?from=${period.from}&to=${period.to}`;
  return (
    <>
      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="period-heading">
        <p className="text-sm text-ink-muted">{ws.name}</p>
        <h2 id="period-heading" className="mb-1 mt-1 text-base font-medium text-ink">
          Period
        </h2>
        <p className="mb-4 text-sm text-ink-muted">
          Counts what happened between the two dates, both included (UTC): a document sent in the period counts as sent, one completed in it as completed, and so on. The average time to complete is from sending to the last signature, for documents completed in the period.
          {report?.scope === 'own' ? ' As a member you see only the documents you sent.' : ''}
        </p>
        <form method="get" action="/app/reports" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="report-from" className="text-sm font-medium text-ink">
              From
            </label>
            <input id="report-from" name="from" type="date" required defaultValue={period.from} className={INPUT} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="report-to" className="text-sm font-medium text-ink">
              To
            </label>
            <input id="report-to" name="to" type="date" required defaultValue={period.to} className={INPUT} />
          </div>
          <Button type="submit">Show</Button>
        </form>
        {!period.ok ? (
          <div className="mt-4">
            <Notice tone="danger">{period.message}</Notice>
          </div>
        ) : null}
      </section>
      {report ? (
        <>
          <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="totals-heading">
            <h2 id="totals-heading" className="mb-3 text-base font-medium text-ink">
              {report.scope === 'own' ? 'Your documents' : 'Whole workspace'}, {report.from} to {report.to}
            </h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="report-totals">
              {TILES.map((t) => (
                <div key={t.key} className="rounded-md border border-hairline p-3">
                  <dt className="text-sm text-ink-muted">{t.label}</dt>
                  <dd className="text-2xl font-medium text-ink">{report.totals[t.key]}</dd>
                </div>
              ))}
              <div className="rounded-md border border-hairline p-3">
                <dt className="text-sm text-ink-muted">Average to complete</dt>
                <dd className="text-2xl font-medium text-ink">{hoursInWords(report.totals.avg_hours_to_complete)}</dd>
              </div>
            </dl>
            <p className="mt-4">
              <a href={csvHref} download className="inline-flex min-h-11 items-center rounded-pill border border-control-border bg-surface px-6 text-base font-medium text-ink hover:bg-surface-sand">
                Download as CSV
              </a>
            </p>
          </section>
          <Breakdown id="person-heading" caption="By the person who sent them" first="Person" rows={report.by_person} />
          <Breakdown id="template-heading" caption="By template" first="Template" rows={report.by_template} />
        </>
      ) : period.ok ? (
        <Notice tone="danger">The report could not be made. Try again in a moment.</Notice>
      ) : null}
    </>
  );
}

export default function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-medium text-ink">Reports</h1>
      <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
