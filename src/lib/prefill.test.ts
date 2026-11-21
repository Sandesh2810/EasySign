// Prefilled values (Phase 4 slice 5, D-80). The same examples are checked in the database
// (supabase/tests/phase4_slice5_prefill.sql, T643).
import { describe, expect, it } from 'vitest';
import { fieldOptionsProblem } from './fields';

describe('prefilled values (fieldOptionsProblem)', () => {
  it('only fields the signer fills in can be prefilled', () => {
    expect(fieldOptionsProblem('signature', { prefill: 'x' })).toMatch(/Only fields the signer fills in/);
    expect(fieldOptionsProblem('note', { text: 'n', prefill: 'x' })).toMatch(/Only fields the signer fills in/);
    expect(fieldOptionsProblem('formula', { formula: '1', prefill: '2' })).toMatch(/Only fields the signer fills in/);
    expect(fieldOptionsProblem('text', { prefill: 'Acme Ltd' })).toBeNull();
  });
  it('a locked value needs a value', () => {
    expect(fieldOptionsProblem('text', { readonly: true })).toMatch(/needs a prefilled value/);
    expect(fieldOptionsProblem('text', { readonly: true, prefill: '  ' })).toMatch(/needs a prefilled value/);
    expect(fieldOptionsProblem('text', { readonly: true, prefill: 'Acme Ltd' })).toBeNull();
  });
  it('the value must be one the signer could have given', () => {
    expect(fieldOptionsProblem('radio', { choices: ['Monthly', 'Yearly'], prefill: 'Weekly' })).toMatch(/Prefilled value: Choose one of the options/);
    expect(fieldOptionsProblem('radio', { choices: ['Monthly', 'Yearly'], prefill: 'Yearly' })).toBeNull();
    expect(fieldOptionsProblem('number', { max: 100, prefill: '250' })).toMatch(/Prefilled value: The largest allowed is 100/);
    expect(fieldOptionsProblem('number', { decimals: 0, prefill: '12' })).toBeNull();
    expect(fieldOptionsProblem('checkbox', { prefill: 'yes' })).toMatch(/Prefilled value: Tick the box/);
    expect(fieldOptionsProblem('checkbox', { prefill: 'true', readonly: true })).toBeNull();
    expect(fieldOptionsProblem('text', { check: 'digits', prefill: 'abc' })).toMatch(/Prefilled value: Use digits only/);
  });
  it('merge text: known placeholders only, and only in typed text fields', () => {
    expect(fieldOptionsProblem('text', { prefill: 'Dear {{first_name}}' })).toBeNull();
    expect(fieldOptionsProblem('text', { prefill: 'Dear {{frist_name}}' })).toMatch(/"\{\{frist_name\}\}" is not a merge field/);
    expect(fieldOptionsProblem('number', { prefill: '{{name}}' })).toMatch(/only be used in text, company and title/);
    // a text check is applied to the merged value when the document is sent, not to the placeholder
    expect(fieldOptionsProblem('text', { check: 'email', prefill: '{{email}}' })).toBeNull();
    expect(fieldOptionsProblem('note', { text: 'Hello {{name}}' })).toBeNull();
    expect(fieldOptionsProblem('note', { text: 'Hello {{nmae}}' })).toMatch(/Note: "\{\{nmae\}\}" is not a merge field/);
  });
});
