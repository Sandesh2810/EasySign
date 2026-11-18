// Field definitions shared by the editor (browser) and the server actions. No server-only imports here.
import { z } from 'zod';

export const FIELD_TYPES = ['signature', 'initials', 'date_signed', 'name', 'email', 'company', 'title', 'text'] as const;
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
};

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
