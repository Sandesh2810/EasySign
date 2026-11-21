// D-93: the report's period, wording and CSV (the counting itself is tested against a hand-computed dataset in
// supabase/tests/phase5_slice4_reports.sql).
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { hoursInWords, parsePeriod, reportCsv, reportFilename, type Report } from './reports';

const now = new Date('2026-11-21T10:00:00Z');

describe('period', () => {
  it('defaults to the last 30 days, today included', () => {
    expect(parsePeriod(undefined, undefined, now)).toEqual({ ok: true, from: '2026-10-23', to: '2026-11-21', defaulted: true });
    expect(parsePeriod('', '', now)).toMatchObject({ ok: true, defaulted: true });
  });
  it('accepts a real period of up to two years', () => {
    expect(parsePeriod('2026-03-01', '2026-03-31', now)).toEqual({ ok: true, from: '2026-03-01', to: '2026-03-31', defaulted: false });
    expect(parsePeriod('2024-03-01', '2026-03-02', now).ok).toBe(true); // 731 days
    expect(parsePeriod('2026-03-31', '2026-03-31', now).ok).toBe(true);
  });
  it('refuses what is not a date, a reversed period and more than two years', () => {
    expect(parsePeriod('2026-02-30', '2026-03-31', now)).toMatchObject({ ok: false, message: 'Choose a start and an end date.' });
    expect(parsePeriod('2026-03-01', undefined, now).ok).toBe(false);
    expect(parsePeriod('yesterday', '2026-03-31', now).ok).toBe(false);
    expect(parsePeriod(['2026-03-01'], '2026-03-31', now).ok).toBe(false);
    expect(parsePeriod('2026-03-31', '2026-03-01', now)).toMatchObject({ ok: false, message: 'The end date is before the start date.' });
    expect(parsePeriod('2024-03-01', '2026-03-03', now)).toMatchObject({ ok: false, message: 'Choose a period of up to two years.' });
  });
});

describe('wording', () => {
  it('hours under two days, days after', () => {
    expect(hoursInWords(null)).toBe('–');
    expect(hoursInWords(0)).toBe('under an hour');
    expect(hoursInWords(0.9)).toBe('under an hour');
    expect(hoursInWords(1)).toBe('1 hour');
    expect(hoursInWords(18)).toBe('18 hours');
    expect(hoursInWords(12.5)).toBe('12.5 hours');
    expect(hoursInWords(80)).toBe('3.3 days');
    expect(hoursInWords(204)).toBe('8.5 days');
  });
});

describe('CSV', () => {
  const report: Report = {
    scope: 'workspace',
    from: '2026-03-01',
    to: '2026-03-31',
    totals: { sent: 6, completed: 3, declined: 1, voided: 1, expired: 1, avg_hours_to_complete: 80 },
    by_person: [
      { id: 'a', name: 'Ana Owner', sent: 4, completed: 2, declined: 1, voided: 0, expired: 0, avg_hours_to_complete: 18 },
      { id: 'b', name: '=HYPERLINK("http://evil.example","x")', sent: 2, completed: 1, declined: 0, voided: 1, expired: 1, avg_hours_to_complete: 204 },
    ],
    by_template: [
      { id: 't', name: 'Lease, monthly', sent: 2, completed: 2, declined: 0, voided: 0, expired: 0, avg_hours_to_complete: 18 },
      { id: null, name: null, sent: 1, completed: 1, declined: 1, voided: 0, expired: 0, avg_hours_to_complete: null },
    ],
  };
  it('has the totals, each person and each template, readable back exactly', () => {
    const rows = parseCsv(reportCsv(report));
    expect(rows[0]).toEqual(['section', 'name', 'sent', 'completed', 'declined', 'voided', 'expired', 'average hours to complete']);
    expect(rows[1]).toEqual(['total', 'Whole workspace', '6', '3', '1', '1', '1', '80.0']);
    expect(rows[2]).toEqual(['person', 'Ana Owner', '4', '2', '1', '0', '0', '18.0']);
    expect(rows[4]).toEqual(['template', 'Lease, monthly', '2', '2', '0', '0', '0', '18.0']);
    expect(rows[5]).toEqual(['template', 'Not from a template', '1', '1', '1', '0', '0', '']);
    expect(rows).toHaveLength(6);
  });
  it('neutralises a name that a spreadsheet would run as a formula', () => {
    const rows = parseCsv(reportCsv(report));
    expect(rows[3][1]).toBe(`'=HYPERLINK("http://evil.example","x")`);
  });
  it('says whose documents a member’s report covers, and names the file by its period', () => {
    expect(parseCsv(reportCsv({ ...report, scope: 'own' }))[1][1]).toBe('Your documents');
    expect(reportFilename(report)).toBe('younmesign-report-2026-03-01-to-2026-03-31.csv');
  });
});
