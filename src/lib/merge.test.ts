// Merge text (Phase 4 slice 5, D-80). The same examples are checked in the database (supabase/tests/phase4_slice5_prefill.sql,
// T643), so the editor's checks and the values written when a document is sent agree.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MERGE_FIELDS, mergeProblem, mergeText, placeholders, type MergeData } from './merge';

const data: MergeData = { name: 'Cleo Client', email: 'cleo@example.test', senderName: 'Sam Sender', senderEmail: 'sam@example.test', documentTitle: 'Lease 2027' };

describe('mergeText', () => {
  it('fills every merge field', () => {
    expect(mergeText('Dear {{first_name}}, ({{name}}, {{email}})', data)).toBe('Dear Cleo, (Cleo Client, cleo@example.test)');
    expect(mergeText('From {{sender_name}} <{{sender_email}}> re {{document_title}}', data)).toBe('From Sam Sender <sam@example.test> re Lease 2027');
  });
  it('ignores case and spaces inside the braces', () => {
    expect(mergeText('{{ NAME }} / {{First_Name}}', data)).toBe('Cleo Client / Cleo');
  });
  it('leaves text without placeholders alone, and never re-reads a filled value as a placeholder', () => {
    expect(mergeText('No merge here { name }', data)).toBe('No merge here { name }');
    expect(mergeText('{{name}}', { ...data, name: '{{email}} & \\1 $1' })).toBe('{{email}} & \\1 $1');
  });
  it('a one-word name is its own first name; extra spaces are ignored', () => {
    expect(mergeText('{{first_name}}', { ...data, name: 'Prince' })).toBe('Prince');
    expect(mergeText('{{first_name}}', { ...data, name: '  Ana  Maria Lopez ' })).toBe('Ana');
  });
});

describe('mergeProblem', () => {
  it('names the first unknown placeholder', () => {
    expect(mergeProblem('Hello {{nmae}}')).toMatch(/"\{\{nmae\}\}" is not a merge field/);
    expect(mergeProblem('Hello {{name}} {{company}}')).toMatch(/\{\{company\}\}/);
    expect(mergeProblem('Hello {{name}}')).toBeNull();
    expect(mergeProblem('Plain text')).toBeNull();
  });
  it('lists what was found', () => {
    expect(placeholders('{{name}} and {{ Email }} and {{name}}')).toEqual(['name', 'email', 'name']);
  });
});

describe('properties', () => {
  it('after merging only known placeholders, no known placeholder is left (unless a value itself contains one)', () => {
    const word = fc.string({ maxLength: 12 }).filter((s) => !s.includes('{') && !s.includes('}'));
    const piece = fc.oneof(word, fc.constantFrom(...MERGE_FIELDS.map((f) => `{{${f}}}`)));
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 10 }), word, word, (parts, name, title) => {
        const out = mergeText(parts.join(''), { ...data, name: name || 'X', documentTitle: title });
        expect(placeholders(out)).toEqual([]);
        expect(mergeProblem(parts.join(''))).toBeNull();
      }),
      { numRuns: 1000 },
    );
  });
});
