// Field options and value checks (Phase 4 slice 3, D-78). The same examples are checked in the database
// (supabase/tests/phase4_slice3_field_types.sql, T623/T624), so the editor and signer page agree with the server.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { checkFieldValue, fieldOptionsProblem, fieldOptionsSchema, fieldSchema } from './fields';

describe('fieldOptionsProblem (can this field be sent?)', () => {
  it('radio and dropdown need two to twenty different choices', () => {
    expect(fieldOptionsProblem('radio', {})).toMatch(/two choices/);
    expect(fieldOptionsProblem('radio', { choices: ['Yes'] })).toMatch(/two choices/);
    expect(fieldOptionsProblem('dropdown', { choices: ['A', 'A'] })).toMatch(/different/);
    expect(fieldOptionsProblem('dropdown', { choices: Array.from({ length: 21 }, (_, i) => `c${i}`) })).toMatch(/20/);
    expect(fieldOptionsProblem('radio', { choices: ['Yes', 'No'] })).toBeNull();
  });
  it('a note needs text, a link a full web address', () => {
    expect(fieldOptionsProblem('note', { text: '   ' })).toMatch(/note/);
    expect(fieldOptionsProblem('note', { text: 'Initial each page' })).toBeNull();
    expect(fieldOptionsProblem('hyperlink', { url: 'example.com' })).toMatch(/https/);
    expect(fieldOptionsProblem('hyperlink', { url: 'javascript:alert(1)' })).toMatch(/https/);
    expect(fieldOptionsProblem('hyperlink', { url: 'https://example.com/terms' })).toBeNull();
  });
  it('number limits must be in order; a custom text pattern must be valid', () => {
    expect(fieldOptionsProblem('number', { min: 10, max: 1 })).toMatch(/bigger/);
    expect(fieldOptionsProblem('number', { min: 1, max: 10, decimals: 0 })).toBeNull();
    expect(fieldOptionsProblem('text', { check: 'custom' })).toMatch(/pattern/);
    expect(fieldOptionsProblem('text', { check: 'custom', pattern: '([a-z' })).toMatch(/not valid/);
    expect(fieldOptionsProblem('text', { check: 'custom', pattern: '^[A-Z]{2}[0-9]{4}$' })).toBeNull();
  });
});

describe('checkFieldValue (is the signer value accepted?)', () => {
  it('checkbox: only "true" (empty clears)', () => {
    expect(checkFieldValue('checkbox', {}, 'true')).toBeNull();
    expect(checkFieldValue('checkbox', {}, '')).toBeNull();
    expect(checkFieldValue('checkbox', {}, 'yes')).not.toBeNull();
  });
  it('radio and dropdown: one of the choices exactly', () => {
    const o = { choices: ['Monthly', 'Yearly'] };
    expect(checkFieldValue('radio', o, 'Yearly')).toBeNull();
    expect(checkFieldValue('dropdown', o, 'Weekly')).toMatch(/options/);
    expect(checkFieldValue('dropdown', o, 'yearly')).toMatch(/options/);
  });
  it('number: format, decimals, limits', () => {
    const o = { min: 0, max: 1000, decimals: 2 };
    expect(checkFieldValue('number', o, '12.50')).toBeNull();
    expect(checkFieldValue('number', o, '-1')).toMatch(/smallest/);
    expect(checkFieldValue('number', o, '1000.01')).toMatch(/largest/);
    expect(checkFieldValue('number', o, '1.234')).toMatch(/2 decimal/);
    expect(checkFieldValue('number', { decimals: 0 }, '3.5')).toMatch(/whole/);
    expect(checkFieldValue('number', o, '1e3')).toMatch(/number/);
    expect(checkFieldValue('number', o, '12,5')).toMatch(/number/);
  });
  it('text checks with the sender\'s own message', () => {
    expect(checkFieldValue('text', { check: 'digits' }, '12345')).toBeNull();
    expect(checkFieldValue('text', { check: 'digits' }, '12a45')).toMatch(/digits/);
    expect(checkFieldValue('text', { check: 'letters' }, "Zoë O'Neil-Smith")).toBeNull();
    expect(checkFieldValue('text', { check: 'email' }, 'a@b.co')).toBeNull();
    expect(checkFieldValue('text', { check: 'phone' }, '+44 (20) 7946-0000')).toBeNull();
    expect(checkFieldValue('text', { check: 'phone' }, '12')).toMatch(/phone/);
    expect(checkFieldValue('text', { check: 'custom', pattern: '^[A-Z]{2}[0-9]{4}$', message: 'Use the policy number, like AB1234' }, 'ab1234')).toBe('Use the policy number, like AB1234');
    expect(checkFieldValue('text', { check: 'custom', pattern: '^[A-Z]{2}[0-9]{4}$' }, 'AB1234')).toBeNull();
    expect(checkFieldValue('text', {}, 'anything at all')).toBeNull();
  });
  it('never throws, whatever the sender set up or the signer typed', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 60 }), (pattern, value) => {
        const r = checkFieldValue('text', { check: 'custom', pattern }, value);
        return r === null || typeof r === 'string';
      }),
    );
  });
});

describe('option and field schemas', () => {
  it('reject unknown option keys and oversized values', () => {
    expect(fieldOptionsSchema.safeParse({ choices: ['a', 'b'], onclick: 'x' }).success).toBe(false);
    expect(fieldOptionsSchema.safeParse({ text: 'x'.repeat(501) }).success).toBe(false);
    expect(fieldOptionsSchema.safeParse({ decimals: 3 }).success).toBe(false);
  });
  it('a field defaults to no options', () => {
    const f = fieldSchema.parse({ document_id: '11111111-1111-4111-8111-111111111111', recipient_id: '22222222-2222-4222-8222-222222222222', type: 'checkbox', page: 1, x: 0.1, y: 0.1, w: 0.03, h: 0.02 });
    expect(f.options).toEqual({});
  });
});
