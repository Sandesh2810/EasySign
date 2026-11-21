// CSV for bulk send (Phase 4 slice 9, AT4.2, D-85). A small RFC 4180 reader and writer: commas, double-quoted cells
// with "" for a quote, line breaks inside quotes, CRLF or LF, an optional byte-order mark, a semicolon list when a file
// has no commas in its header (common in European spreadsheet exports). No eval, no regular expressions over the whole
// input, hard limits. The writer neutralises spreadsheet formulas (=, +, -, @, tab, carriage return at the start of a
// cell) so a report opened in Excel can never run anything ("CSV injection").
// No browser or Node imports: the same file runs in the browser (preview) and on the server (authoritative check).

export const CSV_LIMITS = { bytes: 1_000_000, rows: 500, columns: 50, cell: 1000 } as const;

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

/** Rows of cells. Throws CsvError with a plain reason when the file is too big or malformed. */
export function parseCsv(input: string): string[][] {
  if (input.length > CSV_LIMITS.bytes) throw new CsvError('The file is larger than 1 MB. Split it into smaller files.');
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  text = text.replace(/\r\n?/g, '\n');
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > CSV_LIMITS.cell) throw new CsvError(`Row ${rows.length + 1} has a cell longer than ${CSV_LIMITS.cell} characters.`);
    row.push(cell);
    cell = '';
    if (row.length > CSV_LIMITS.columns) throw new CsvError(`Row ${rows.length + 1} has more than ${CSV_LIMITS.columns} columns.`);
  };
  const pushRow = () => {
    pushCell();
    // a line that is completely empty is skipped (e.g. a trailing newline)
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    if (rows.length > CSV_LIMITS.rows + 1) throw new CsvError(`The file has more than ${CSV_LIMITS.rows} rows. Split it into smaller files.`);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i += 1;
    } else if (c === sep) {
      pushCell();
      i += 1;
    } else if (c === '\n') {
      pushRow();
      i += 1;
    } else {
      cell += c;
      i += 1;
    }
  }
  if (quoted) throw new CsvError('A quoted cell is not closed (a " is missing).');
  if (cell !== '' || row.length) pushRow();
  return rows;
}

/** A cell as written to a CSV that people open in spreadsheets: quoted when needed, formulas neutralised. */
export function csvCell(v: string): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: string[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
