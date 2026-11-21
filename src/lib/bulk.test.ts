// CSV and bulk rows (Phase 4 slice 9, AT4.2, D-85).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CsvError, csvCell, CSV_LIMITS, parseCsv, toCsv } from './csv';
import { bulkSendable, checkRows, estimateBulkDays, estimateDays, mapColumns, type TemplateNamedField } from './bulk';

describe('parseCsv', () => {
  it('reads quotes, commas and line breaks inside quotes, CRLF, a byte-order mark, and skips blank lines', () => {
    expect(parseCsv('﻿name,email\r\n"Lee, Ann",ann@example.test\r\n\r\n"Say ""hi""\nthere",b@example.test\n')).toEqual([
      ['name', 'email'],
      ['Lee, Ann', 'ann@example.test'],
      ['Say "hi"\nthere', 'b@example.test'],
    ]);
  });
  it('reads semicolon files (spreadsheet exports in many countries)', () => {
    expect(parseCsv('name;email\nAnn;ann@example.test')).toEqual([['name', 'email'], ['Ann', 'ann@example.test']]);
  });
  it('refuses oversized and malformed files with a plain reason', () => {
    expect(() => parseCsv('a,"b')).toThrow(/not closed/);
    expect(() => parseCsv('x'.repeat(CSV_LIMITS.bytes + 1))).toThrow(/larger than 1 MB/);
    expect(() => parseCsv(Array.from({ length: CSV_LIMITS.rows + 2 }, () => 'a,b').join('\n'))).toThrow(/more than 500 rows/);
    expect(() => parseCsv(Array.from({ length: 51 }, () => 'a').join(','))).toThrow(/more than 50 columns/);
    expect(() => parseCsv(`a,${'y'.repeat(1001)}`)).toThrow(CsvError);
  });
});

describe('csvCell (writing reports people open in spreadsheets)', () => {
  it('neutralises formulas and quotes what needs quoting', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});

describe('properties', () => {
  const cell = fc.string({ maxLength: 20 }).filter((s) => !/^[=+\-@\t\r]/.test(s) && !s.includes('\r'));
  it('writing then reading gives the same rows back (cells that do not start like a formula)', () => {
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 2, maxLength: 5 }), { minLength: 1, maxLength: 20 }), (rows) => {
        // a row that is a single empty cell is a blank line by design; give every row two cells
        expect(parseCsv(toCsv(rows))).toEqual(rows);
      }),
      { numRuns: 500 },
    );
  });
  it('any text gives rows or a plain CsvError, never another failure', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        try {
          parseCsv(s);
        } catch (e) {
          expect(e).toBeInstanceOf(CsvError);
        }
      }),
      { numRuns: 2000 },
    );
  });
  it('a written cell never starts with a formula character', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const out = csvCell(s).replace(/^"/, '');
        expect(/^[=+\-@\t\r]/.test(out)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

const FIELDS: TemplateNamedField[] = [
  { name: 'rent', type: 'number', options: { decimals: 0, min: 1 } },
  { name: 'plan', type: 'radio', options: { choices: ['Monthly', 'Yearly'] } },
];

describe('mapColumns and checkRows', () => {
  it('finds name, email and named-field columns by header', () => {
    expect(mapColumns(['Full Name', 'E-mail address', 'Rent', 'Notes'], FIELDS)).toEqual({ map: { name: 0, email: 1, values: { rent: 2 } }, problems: [] });
    expect(mapColumns(['who', 'mail'], FIELDS).problems).toEqual(['There is no "name" column.', 'There is no "email" column.']);
  });
  it('reports each bad row with its reason and keeps the good ones', () => {
    const rows = checkRows(
      [
        ['Ann Able', 'Ann@Example.test', '1200', 'Yearly'],
        ['', 'b@example.test', '', ''],
        ['Cy', 'not-an-email', '', ''],
        ['Dee', 'ann@example.test', '', ''],
        ['Eve', 'eve@example.test', 'abc', ''],
        ['Fay', 'fay@example.test', '', 'Weekly'],
        ['Gil', 'gil@example.test', '', ''],
      ],
      { name: 0, email: 1, values: { rent: 2, plan: 3 } },
      FIELDS,
    );
    expect(rows.map((r) => r.problem)).toEqual([
      null,
      'The name is empty.',
      '"not-an-email" is not a valid email address.',
      'The same email address is already on row 1.',
      'rent: Enter a number, like 12 or 12.50',
      'plan: Choose one of the options.',
      null,
    ]);
    expect(rows[0]).toMatchObject({ email: 'ann@example.test', values: { rent: '1200', plan: 'Yearly' } });
    expect(rows[6].values).toEqual({});
  });
});

describe('pacing', () => {
  it('sends only what today’s email allowance can carry, minus what is already waiting', () => {
    expect(bulkSendable(50, 0, 10)).toBe(10);
    expect(bulkSendable(5, 2, 10)).toBe(3);
    expect(bulkSendable(5, 9, 10)).toBe(0);
    expect(estimateDays(195, 85)).toBe(3);
    expect(estimateDays(0, 85)).toBe(0);
    expect(estimateDays(10, 0)).toBeNull();
  });
  it('estimates calendar days: what is left today, then full days (AT4.2: 195 documents take several days)', () => {
    expect(estimateBulkDays(195, 20, 85)).toBe(4); // 20 today, then 85 + 85 + 5
    expect(estimateBulkDays(195, 0, 85)).toBe(4); // none today, then 3 full days
    expect(estimateBulkDays(10, 20, 85)).toBe(1);
    expect(estimateBulkDays(0, 0, 85)).toBe(0);
    expect(estimateBulkDays(5, 0, 0)).toBeNull();
  });
});
