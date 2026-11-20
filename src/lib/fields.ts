// Field definitions shared by the editor (browser) and the server actions. No server-only imports here.
import { z } from 'zod';

export const FIELD_TYPES = [
  'signature', 'initials', 'date_signed', 'name', 'email', 'company', 'title', 'text',
  // Phase 4 slice 3 (D-78)
  'checkbox', 'radio', 'dropdown', 'number', 'note', 'hyperlink', 'attachment',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_LABEL: Record<FieldType, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date_signed: 'Date signed',
  name: 'Name',
  email: 'Email',
  company: 'Company',
  title: 'Title',
  text: 'Text',
  checkbox: 'Checkbox',
  radio: 'Choose one',
  dropdown: 'Dropdown',
  number: 'Number',
  note: 'Note',
  hyperlink: 'Link',
  attachment: 'Attachment',
};

/** Default size in PDF points (1/72 inch) when a field is first placed. */
export const FIELD_DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 190, h: 56 },
  initials: { w: 70, h: 44 },
  date_signed: { w: 110, h: 24 },
  name: { w: 170, h: 24 },
  email: { w: 190, h: 24 },
  company: { w: 170, h: 24 },
  title: { w: 150, h: 24 },
  text: { w: 170, h: 24 },
  checkbox: { w: 18, h: 18 },
  radio: { w: 170, h: 64 },
  dropdown: { w: 170, h: 24 },
  number: { w: 110, h: 24 },
  note: { w: 230, h: 48 },
  hyperlink: { w: 170, h: 20 },
  attachment: { w: 200, h: 28 },
};

/** Shown to the signer, never filled in and never required. */
export const INFO_ONLY: readonly FieldType[] = ['note', 'hyperlink'];
/** Filled in by typing (on a phone, through the large entry box). */
export const TYPED_TYPES: readonly FieldType[] = ['company', 'title', 'text', 'number'];

// ---------- options (D-78). The database has the same rules: app_private.field_options_problem / field_value_problem ----------
export const TEXT_CHECKS = ['digits', 'letters', 'email', 'phone', 'custom'] as const;
export type TextCheck = (typeof TEXT_CHECKS)[number];
/** Same patterns as the database (Postgres regular expressions); letters = any letter plus space . ' - */
const CHECK_PATTERN: Record<Exclude<TextCheck, 'custom'>, RegExp> = {
  digits: /^[0-9]+$/,
  letters: /^[\p{L} .'-]+$/u,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  phone: /^\+?[0-9 ()-]{6,20}$/,
};
const CHECK_MESSAGE: Record<TextCheck, string> = {
  digits: 'Use digits only (0 to 9)',
  letters: 'Use letters only',
  email: 'Enter an email address, like name@example.com',
  phone: 'Enter a phone number: digits, spaces, brackets or a dash, 6 to 20 characters',
  custom: 'This does not have the expected format',
};

export const fieldOptionsSchema = z
  .object({
    choices: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    decimals: z.number().int().min(0).max(2).optional(),
    text: z.string().max(500).optional(),
    url: z.string().max(500).optional(),
    label: z.string().max(60).optional(),
    check: z.enum(TEXT_CHECKS).optional(),
    pattern: z.string().max(100).optional(),
    message: z.string().max(120).optional(),
  })
  .strict();
export type FieldOptions = z.infer<typeof fieldOptionsSchema>;

/** Why a field cannot be sent as it is set up, or null. Checked again by the database when the document is sent. */
export function fieldOptionsProblem(type: FieldType, o: FieldOptions = {}): string | null {
  switch (type) {
    case 'radio':
    case 'dropdown': {
      const c = (o.choices ?? []).map((s) => s.trim()).filter(Boolean);
      if (c.length < 2) return 'Give at least two choices.';
      if (c.length > 20) return 'Up to 20 choices.';
      if (new Set(c).size !== c.length) return 'Each choice must be different.';
      if (c.some((s) => s.length > 60)) return 'Choices can be up to 60 characters.';
      return null;
    }
    case 'number':
      if (o.min !== undefined && o.max !== undefined && o.min > o.max) return 'The smallest number is bigger than the largest.';
      return null;
    case 'note':
      return (o.text ?? '').trim() ? null : 'Type the note.';
    case 'hyperlink':
      return /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(o.url ?? '') ? null : 'Give the full web address, starting with https://';
    case 'text':
    case 'company':
    case 'title':
      if (o.check === 'custom') {
        if (!o.pattern || o.pattern.length > 100) return 'Type the pattern (up to 100 characters).';
        try {
          new RegExp(o.pattern, 'u');
        } catch {
          return 'That pattern is not valid.';
        }
      }
      return null;
    default:
      return null;
  }
}

/** Why a signer's value is not accepted, or null. The database checks the same before storing it. */
export function checkFieldValue(type: FieldType, o: FieldOptions, raw: string): string | null {
  const v = raw.trim();
  if (v === '') return null; // empty clears; "required" is checked when signing
  switch (type) {
    case 'checkbox':
      return v === 'true' ? null : 'Tick the box or leave it empty.';
    case 'radio':
    case 'dropdown':
      return (o.choices ?? []).includes(v) ? null : 'Choose one of the options.';
    case 'number': {
      const dec = o.decimals ?? 2;
      if (!/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return 'Enter a number, like 12 or 12.50';
      const places = v.includes('.') ? v.split('.')[1].length : 0;
      if (places > dec) return dec === 0 ? 'Use a whole number.' : `Use at most ${dec} decimal place${dec === 1 ? '' : 's'}.`;
      const n = Number(v);
      if (o.min !== undefined && n < o.min) return `The smallest allowed is ${o.min}.`;
      if (o.max !== undefined && n > o.max) return `The largest allowed is ${o.max}.`;
      return null;
    }
    case 'text':
    case 'company':
    case 'title': {
      if (!o.check) return null;
      const re = o.check === 'custom' ? safeRegExp(o.pattern) : CHECK_PATTERN[o.check];
      if (!re) return 'This field is set up wrongly. Tell the sender.';
      return re.test(v) ? null : o.message?.trim() || CHECK_MESSAGE[o.check];
    }
    default:
      return null;
  }
}

function safeRegExp(p?: string): RegExp | null {
  try {
    return p ? new RegExp(p, 'u') : null;
  } catch {
    return null;
  }
}

const frac = z.number().min(0).max(1);

export const fieldSchema = z
  .object({
    document_id: z.uuid(),
    recipient_id: z.uuid(),
    type: z.enum(FIELD_TYPES),
    page: z.number().int().min(1).max(100),
    x: frac,
    y: frac,
    w: frac.gt(0),
    h: frac.gt(0),
    required: z.boolean().default(true),
    options: fieldOptionsSchema.default({}),
  })
  .refine((f) => f.x + f.w <= 1.000001 && f.y + f.h <= 1.000001, { message: 'Field lies outside the page' });

export const fieldsSchema = z.array(fieldSchema).max(500);
export type FieldInput = z.infer<typeof fieldSchema>;

/** Fractions are stored to six decimals: far finer than a pixel, and identical after a reload. */
export const roundFrac = (n: number) => Math.round(n * 1e6) / 1e6;

/** Keep a rectangle inside the page. */
export function clampRect(r: { x: number; y: number; w: number; h: number }) {
  const w = Math.min(Math.max(r.w, 0.01), 1);
  const h = Math.min(Math.max(r.h, 0.005), 1);
  return { x: roundFrac(Math.min(Math.max(r.x, 0), 1 - w)), y: roundFrac(Math.min(Math.max(r.y, 0), 1 - h)), w: roundFrac(w), h: roundFrac(h) };
}
