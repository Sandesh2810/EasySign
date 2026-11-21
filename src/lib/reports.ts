// D-93: reports. The numbers come from public.report_summary (the database counts); this file chooses the period,
// words the hours and writes the CSV. Pure: no I/O.
import { toCsv } from './csv';

export interface ReportNumbers {
  sent: number;
  completed: number;
  declined: number;
  voided: number;
  expired: number;
  avg_hours_to_complete: number | null;
}
export interface ReportRow extends ReportNumbers {
  id: string | null;
  name: string | null;
}
export interface Report {
  scope: 'workspace' | 'own';
  from: string;
  to: string;
  totals: ReportNumbers;
  by_person: ReportRow[];
  by_template: ReportRow[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PERIOD_DAYS = 731;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (s: unknown): s is string => typeof s === 'string' && DAY.test(s) && iso(new Date(`${s}T00:00:00Z`)) === s;

export type Period = { ok: true; from: string; to: string; defaulted: boolean } | { ok: false; message: string; from: string; to: string };

/** The period asked for in the address, or the last 30 days (UTC, today included) when none was given. */
export function parsePeriod(from: unknown, to: unknown, now = new Date()): Period {
  const today = iso(now);
  const monthAgo = iso(new Date(now.getTime() - 29 * 86_400_000));
  if ((from === undefined || from === '') && (to === undefined || to === '')) return { ok: true, from: monthAgo, to: today, defaulted: true };
  if (!validDay(from) || !validDay(to)) return { ok: false, message: 'Choose a start and an end date.', from: monthAgo, to: today };
  if (to < from) return { ok: false, message: 'The end date is before the start date.', from, to };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_PERIOD_DAYS) return { ok: false, message: 'Choose a period of up to two years.', from, to };
  return { ok: true, from, to, defaulted: false };
}

/** "under an hour", "18 hours", "3.3 days", or "–" when nothing was completed. */
export function hoursInWords(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return '–';
  if (h < 1) return 'under an hour';
  if (h < 48) return `${h.toFixed(1).replace(/\.0$/, '')} hour${h === 1 ? '' : 's'}`;
  return `${(h / 24).toFixed(1).replace(/\.0$/, '')} days`;
}

export const NO_TEMPLATE = 'Not from a template';
const HEAD = ['section', 'name', 'sent', 'completed', 'declined', 'voided', 'expired', 'average hours to complete'];
const cells = (section: string, name: string, n: ReportNumbers) => [
  section, name, String(n.sent), String(n.completed), String(n.declined), String(n.voided), String(n.expired), n.avg_hours_to_complete === null ? '' : n.avg_hours_to_complete.toFixed(1),
];

/** The report as CSV: one line for the total, then one per person and per template. Formula-looking names are neutralised. */
export function reportCsv(r: Report): string {
  return toCsv([
    HEAD,
    cells('total', r.scope === 'own' ? 'Your documents' : 'Whole workspace', r.totals),
    ...r.by_person.map((p) => cells('person', p.name ?? 'Unknown', p)),
    ...r.by_template.map((t) => cells('template', t.name ?? NO_TEMPLATE, t)),
  ]);
}

export const reportFilename = (r: Pick<Report, 'from' | 'to'>) => `younmesign-report-${r.from}-to-${r.to}.csv`;
