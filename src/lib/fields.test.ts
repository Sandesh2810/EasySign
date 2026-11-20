import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { clampRect, fieldSchema, fieldsSchema, roundFrac } from './fields';

const base = { document_id: '11111111-1111-4111-8111-111111111111', recipient_id: '22222222-2222-4222-8222-222222222222', type: 'signature' as const, page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.05, required: true };

describe('field validation', () => {
  it('accepts a normal field and defaults required to true', () => {
    expect(fieldSchema.safeParse(base).success).toBe(true);
    const rest: Record<string, unknown> = { ...base };
    delete rest.required;
    const p = fieldSchema.parse(rest);
    expect(p.required).toBe(true);
  });
  it('rejects unknown types, bad ids, and geometry outside the page', () => {
    for (const bad of [
      { ...base, type: 'javascript' }, // (was 'checkbox', a real type since Phase 4 slice 3)
      { ...base, document_id: 'nope' },
      { ...base, page: 0 },
      { ...base, x: -0.01 },
      { ...base, w: 0 },
      { ...base, x: 0.8, w: 0.3 },
      { ...base, y: 0.97, h: 0.05 },
      { ...base, x: Number.NaN },
    ]) {
      expect(fieldSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('caps the number of fields', () => {
    expect(fieldsSchema.safeParse(Array.from({ length: 501 }, () => base)).success).toBe(false);
  });
});

describe('clampRect', () => {
  it('always returns a rectangle that passes validation, whatever it is given', () => {
    fc.assert(
      fc.property(fc.double({ min: -2, max: 3, noNaN: true }), fc.double({ min: -2, max: 3, noNaN: true }), fc.double({ min: -1, max: 3, noNaN: true }), fc.double({ min: -1, max: 3, noNaN: true }), (x, y, w, h) => {
        const r = clampRect({ x, y, w, h });
        return fieldSchema.safeParse({ ...base, ...r }).success;
      }),
    );
  });
  it('AT1.4: values survive a save and reload unchanged (six-decimal rounding is stable)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.6, noNaN: true }), fc.double({ min: 0, max: 0.6, noNaN: true }), (x, y) => {
        const once = clampRect({ x, y, w: 0.3, h: 0.05 });
        const viaDatabase = { x: Number(once.x.toFixed(8)), y: Number(once.y.toFixed(8)), w: Number(once.w.toFixed(8)), h: Number(once.h.toFixed(8)) }; // numeric(9,8) round trip
        expect(clampRect(viaDatabase)).toEqual(once);
        expect(roundFrac(once.x)).toBe(once.x);
      }),
    );
  });
});
