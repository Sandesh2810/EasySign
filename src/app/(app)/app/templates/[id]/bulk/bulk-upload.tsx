'use client';
// Bulk send, step by step (D-85): choose a CSV, see how its columns are read, see every row (ready or why not), choose how
// it goes out, and see how long it will take before anything is created. The server checks every row again.
import { useMemo, useState, useTransition } from 'react';
import { Button, Notice } from '@/components/ui';
import { checkRows, estimateBulkDays, mapColumns, type BulkRow, type TemplateNamedField } from '@/lib/bulk';
import { CsvError, parseCsv } from '@/lib/csv';
import { createBulkAction } from '../../../bulk/actions';

const SELECT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';

export function BulkUpload({ templateId, roleLabel, fields, leftToday, perFullDay }: { templateId: string; roleLabel: string; fields: TemplateNamedField[]; leftToday: number; perFullDay: number }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [mapped, setMapped] = useState<string[]>([]);
  const [delivery, setDelivery] = useState<'email' | 'link'>('link');
  const [days, setDays] = useState(30);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    setError(null);
    setRows([]);
    setResult(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const all = parseCsv(await file.text());
      if (all.length < 2) throw new CsvError('The file needs a header row and at least one row of people.');
      const { map, problems } = mapColumns(all[0], fields);
      if (!map) throw new CsvError(`${problems.join(' ')} The first row must name the columns, for example: name,email`);
      setHeaders(all[0]);
      setMapped(Object.keys(map.values));
      setRows(checkRows(all.slice(1), map, fields));
    } catch (e) {
      setError(e instanceof CsvError ? e.message : 'The file could not be read. Save it as CSV (comma-separated) and try again.');
    }
  };

  const good = useMemo(() => rows.filter((r) => !r.problem), [rows]);
  const bad = useMemo(() => rows.filter((r) => r.problem), [rows]);
  const est = delivery === 'email' ? estimateBulkDays(good.length, leftToday, perFullDay) : null;

  const create = () =>
    start(async () => {
      const res = await createBulkAction({ templateId, delivery, expiresDays: days, rows: rows.map((r) => ({ rowNo: r.rowNo, name: r.name, email: r.email, values: r.values })) }).catch(() => ({
        ok: false as const,
        message: 'Could not reach the server. Nothing was created.',
      }));
      if (res && !res.ok) setResult(res.message);
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 text-base text-ink-body">
        <p>
          Each row of your file becomes one document for the <strong>{roleLabel}</strong>. The first row names the columns: <code>name</code> and <code>email</code> are needed
          {fields.length ? (
            <>
              ; columns named after this template&apos;s fields fill them in: <code>{fields.map((f) => f.name).join(', ')}</code>
            </>
          ) : null}
          . Up to 500 rows.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="bulk-file" className="text-sm font-medium text-ink">
          CSV file
        </label>
        <input id="bulk-file" type="file" accept=".csv,text/csv" onChange={(e) => void read(e.target.files?.[0])} className="text-base text-ink" />
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {rows.length ? (
        <>
          <p className="text-base text-ink" role="status">
            {fileName}: <strong>{good.length}</strong> ready, <strong>{bad.length}</strong> with a problem (these will not be sent).
            {mapped.length ? ` Filled in from the file: ${mapped.join(', ')}.` : ''}
            {headers.length > 2 + mapped.length ? ' Other columns are ignored.' : ''}
          </p>
          {bad.length ? (
            <div>
              <h2 className="text-base font-medium text-ink">Rows with a problem</h2>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-ink-body">
                {bad.slice(0, 100).map((r) => (
                  <li key={r.rowNo}>
                    Row {r.rowNo}
                    {r.name ? ` (${r.name})` : ''}: {r.problem}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The first rows that will be sent</caption>
              <thead>
                <tr className="text-ink-muted">
                  <th className="py-1 pr-3 font-medium">Row</th>
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Email</th>
                  {mapped.map((m) => (
                    <th key={m} className="py-1 pr-3 font-medium">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {good.slice(0, 20).map((r) => (
                  <tr key={r.rowNo} className="border-t border-hairline text-ink">
                    <td className="py-1 pr-3">{r.rowNo}</td>
                    <td className="py-1 pr-3">{r.name}</td>
                    <td className="py-1 pr-3 break-all">{r.email}</td>
                    {mapped.map((m) => (
                      <td key={m} className="py-1 pr-3">
                        {r.values[m] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {good.length > 20 ? <p className="mt-1 text-sm text-ink-muted">…and {good.length - 20} more.</p> : null}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ink">How do they get their link?</legend>
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
              <input type="radio" name="bulk-delivery" checked={delivery === 'link'} onChange={() => setDelivery('link')} className="mt-0.5 size-5 accent-ink" />
              <span>
                I share the links myself
                <span className="block text-ink-muted">All documents are made straight away; copy each link from its document page. Uses none of the email allowance.</span>
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
              <input type="radio" name="bulk-delivery" checked={delivery === 'email'} onChange={() => setDelivery('email')} className="mt-0.5 size-5 accent-ink" />
              <span>
                By email
                <span className="block text-ink-muted">
                  Emails are limited per day, so they go out over time.
                  {good.length ? (est === null ? ' No request emails can go out at the moment (the monthly allowance is used up).' : ` At the current allowance this takes about ${est} day${est === 1 ? '' : 's'} (${Math.max(0, leftToday)} can go today).`) : ''}
                </span>
              </span>
            </label>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bulk-days" className="text-sm font-medium text-ink">
              Each link stops working after
            </label>
            <select id="bulk-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${SELECT} w-fit`}>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
            </select>
            <p className="text-sm text-ink-muted">Counted from when each document is sent.</p>
          </div>
          {result ? <Notice tone="danger">{result}</Notice> : null}
          <div>
            <Button type="button" onClick={create} disabled={pending || good.length === 0}>
              {pending ? 'Creating…' : `Create ${good.length} document${good.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
