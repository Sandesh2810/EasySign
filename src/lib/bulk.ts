// Bulk send rows (Phase 4 slice 9, AT4.2, D-85): which CSV column is what, and whether each row can become a document.
// The browser uses this for the preview; the server repeats the same checks (and the database checks values again).
import { checkFieldValue, type FieldOptions, type FieldType } from './fields';

export interface TemplateNamedField {
  name: string;
  type: FieldType;
  options: FieldOptions;
}
export interface ColumnMap {
  name: number;
  email: number;
  /** field name -> column index */
  values: Record<string, number>;
}
export interface BulkRow {
  /** 1-based row number in the file, header excluded */
  rowNo: number;
  name: string;
  email: string;
  values: Record<string, string>;
  /** why this row cannot become a document, or null */
  problem: string | null;
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Columns by header: "name"/"full name", "email"/"e-mail address", and any header equal to a named field. */
export function mapColumns(headers: string[], fields: TemplateNamedField[]): { map: ColumnMap | null; problems: string[] } {
  const hs = headers.map(norm);
  const find = (...names: string[]) => hs.findIndex((h) => names.includes(h));
  const name = find('name', 'full_name', 'signer_name', 'recipient_name');
  const email = find('email', 'e_mail', 'email_address', 'e_mail_address', 'signer_email', 'recipient_email');
  const problems: string[] = [];
  if (name < 0) problems.push('There is no "name" column.');
  if (email < 0) problems.push('There is no "email" column.');
  const values: Record<string, number> = {};
  for (const f of fields) {
    const i = hs.indexOf(f.name);
    if (i >= 0 && i !== name && i !== email) values[f.name] = i;
  }
  return { map: problems.length ? null : { name, email, values }, problems };
}

/** Every row checked: name, email, duplicates (same email twice in the file), and each value against its field. */
export function checkRows(rows: string[][], map: ColumnMap, fields: TemplateNamedField[]): BulkRow[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const seen = new Map<string, number>();
  return rows.map((cells, i) => {
    const rowNo = i + 1;
    const name = (cells[map.name] ?? '').trim();
    const email = (cells[map.email] ?? '').trim().toLowerCase();
    const values: Record<string, string> = {};
    for (const [field, col] of Object.entries(map.values)) {
      const v = (cells[col] ?? '').trim();
      if (v !== '') values[field] = v;
    }
    let problem: string | null = null;
    if (!name) problem = 'The name is empty.';
    else if (name.length > 120) problem = 'The name is longer than 120 characters.';
    else if (!EMAIL.test(email) || email.length > 254) problem = `"${email || '(empty)'}" is not a valid email address.`;
    else if (seen.has(email)) problem = `The same email address is already on row ${seen.get(email)}.`;
    else {
      for (const [field, v] of Object.entries(values)) {
        const f = byName.get(field)!;
        const p = checkFieldValue(f.type, f.options, v);
        if (p) {
          problem = `${field}: ${p}`;
          break;
        }
        if (v.length > 500) {
          problem = `${field}: longer than 500 characters.`;
          break;
        }
      }
    }
    if (!problem) seen.set(email, rowNo);
    return { rowNo, name, email, values, problem };
  });
}

/**
 * How many documents can go out now when they are sent by email: today's remaining request allowance, less request
 * emails already waiting to go, never more than `perTick` at once.
 */
export function bulkSendable(allowanceLeft: number, alreadyQueued: number, perTick: number): number {
  return Math.max(0, Math.min(perTick, allowanceLeft - alreadyQueued));
}

/**
 * Calendar days to send `count` documents by email: what is left of today's allowance today, then a full day's allowance
 * each following day. null when nothing can be sent at all (e.g. the month's allowance is used up).
 */
export function estimateBulkDays(count: number, leftToday: number, perFullDay: number): number | null {
  if (count <= 0) return 0;
  const today = Math.max(0, leftToday);
  if (count <= today) return 1;
  const later = estimateDays(count - today, perFullDay);
  // today counts as the first day (whether some go today or none can), then the full days after it
  return later === null ? null : 1 + later;
}

/** Days needed at a daily rate (at least 1 when there is anything to send). */
export function estimateDays(count: number, perDay: number): number | null {
  if (count <= 0) return 0;
  if (perDay <= 0) return null;
  return Math.ceil(count / perDay);
}
