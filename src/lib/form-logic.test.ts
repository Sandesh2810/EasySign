// Formulas and conditions across fields (Phase 4 slice 4, AT4.4, D-79).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fieldOptionsProblem, type FieldOptions, type FieldType } from './fields';
import { computeForm, logicProblems, type LogicField } from './form-logic';

let n = 0;
const F = (type: FieldType, options: FieldOptions = {}, recipient_id = 'r1'): LogicField => ({ id: `f${++n}`, type, recipient_id, page: 1, options });
const run = (fields: LogicField[], values: Record<string, string>) => {
  const byName = new Map(fields.map((f) => [f.options.name, f.id]));
  const byId: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) byId[byName.get(k) ?? k] = v;
  return computeForm(fields, (id) => byId[id] ?? '');
};
const valueOf = (st: ReturnType<typeof computeForm>, f: LogicField) => {
  const c = st.computed.get(f.id);
  return c ? (c.ok ? c.value : `ERR ${c.error}`) : undefined;
};

describe('calculated fields', () => {
  it('quantity × price, VAT and a total built from other calculations, to the cent', () => {
    const qty = F('number', { name: 'qty', decimals: 0 });
    const price = F('number', { name: 'price' });
    const net = F('formula', { name: 'net', formula: 'qty * price' });
    const vat = F('formula', { name: 'vat', formula: 'round(net * 0.2, 2)' });
    const total = F('formula', { formula: 'net + vat' });
    const fields = [qty, price, net, vat, total];
    const st = run(fields, { qty: '3', price: '19.99' });
    expect(valueOf(st, net)).toBe('59.97');
    expect(valueOf(st, vat)).toBe('11.99');
    expect(valueOf(st, total)).toBe('71.96');
    expect(st.hidden.size).toBe(0);
  });
  it('empty inputs count as 0; decimals 0 rounds half away from zero', () => {
    const a = F('number', { name: 'a' });
    const r = F('formula', { formula: 'a / 2', decimals: 0 });
    expect(valueOf(run([a, r], {}), r)).toBe('0');
    expect(valueOf(run([a, r], { a: '5' }), r)).toBe('3');
    expect(valueOf(run([a, r], { a: '-5' }), r)).toBe('-3');
  });
  it('a calculation that cannot be worked out says why (never throws)', () => {
    const a = F('number', { name: 'a' });
    const b = F('number', { name: 'b' });
    const r = F('formula', { name: 'r', formula: 'a / b' });
    const s = F('formula', { formula: 'r + 1' });
    const st = run([a, b, r, s], { a: '1' });
    expect(valueOf(st, r)).toMatch(/ERR Division by zero/);
    expect(valueOf(st, s)).toMatch(/ERR "r" cannot be worked out/);
  });
  it('text from a choice can drive a price', () => {
    const plan = F('radio', { name: 'plan', choices: ['Monthly', 'Yearly'] });
    const fee = F('formula', { formula: 'if(plan == "Yearly", 1200, 120)' });
    expect(valueOf(run([plan, fee], { plan: 'Yearly' }), fee)).toBe('1200.00');
    expect(valueOf(run([plan, fee], { plan: 'Monthly' }), fee)).toBe('120.00');
  });
});

describe('conditions', () => {
  it('a field shows only when its condition is true; a ticked box can be the condition', () => {
    const agree = F('checkbox', { name: 'agree' });
    const reason = F('text', { show_if: 'not agree' });
    expect(run([agree, reason], { agree: 'true' }).hidden.has(reason.id)).toBe(true);
    expect(run([agree, reason], { agree: '' }).hidden.has(reason.id)).toBe(false);
  });
  it('a hidden field counts as empty everywhere, including in totals and in other conditions', () => {
    const extra = F('checkbox', { name: 'extra' });
    const extraQty = F('number', { name: 'extra_qty', show_if: 'extra' });
    const total = F('formula', { formula: '10 + extra_qty * 5' });
    const note = F('text', { show_if: 'extra_qty > 0' });
    // the signer typed 4 while the box was ticked, then unticked it: the 4 must not count
    const st = run([extra, extraQty, total, note], { extra: '', extra_qty: '4' });
    expect(st.hidden.has(extraQty.id)).toBe(true);
    expect(valueOf(st, total)).toBe('10.00');
    expect(st.hidden.has(note.id)).toBe(true);
    const st2 = run([extra, extraQty, total, note], { extra: 'true', extra_qty: '4' });
    expect(valueOf(st2, total)).toBe('30.00');
    expect(st2.hidden.has(note.id)).toBe(false);
  });
  it('a hidden calculated field is not computed at all', () => {
    const show = F('checkbox', { name: 'show' });
    const r = F('formula', { formula: '1 / 0', show_if: 'show' });
    const st = run([show, r], {});
    expect(st.hidden.has(r.id)).toBe(true);
    expect(st.computed.has(r.id)).toBe(false);
  });
  it('a condition that cannot be worked out leaves the field shown', () => {
    const t = F('text', { name: 't' });
    const x = F('text', { show_if: 't + 1 > 2' });
    expect(run([t, x], { t: 'abc' }).hidden.has(x.id)).toBe(false);
  });
  it('signatures and initials are never hidden, whatever their options say', () => {
    const s = F('signature', { show_if: 'false' });
    expect(run([s], {}).hidden.size).toBe(0);
  });
});

describe('send checks across fields (logicProblems)', () => {
  const msgs = (fields: LogicField[]) => logicProblems(fields).map((p) => p.message);
  it('names must be different', () => {
    expect(msgs([F('number', { name: 'qty' }), F('number', { name: 'qty' })])).toEqual([expect.stringMatching(/already named "qty"/)]);
  });
  it('every name used must exist, and belong to the same person', () => {
    expect(msgs([F('formula', { formula: 'qty * 2' })])).toEqual([expect.stringMatching(/No field is named "qty"/)]);
    expect(msgs([F('number', { name: 'qty' }, 'r2'), F('formula', { formula: 'qty * 2' }, 'r1')])).toEqual([expect.stringMatching(/another person/)]);
    expect(msgs([F('text', { name: 'x' }, 'r2'), F('text', { show_if: 'x == "a"' }, 'r1')])).toEqual([expect.stringMatching(/another person/)]);
  });
  it('refuses circles: itself, two fields, and through a condition', () => {
    expect(msgs([F('formula', { name: 'a', formula: 'a + 1' })])).toEqual([expect.stringMatching(/circle/)]);
    expect(msgs([F('formula', { name: 'a', formula: 'b + 1' }), F('formula', { name: 'b', formula: 'a + 1' })])).toEqual([expect.stringMatching(/circle: "a" → "b" → "a"/)]);
    expect(msgs([F('text', { name: 'a', show_if: 'b == "x"' }), F('text', { name: 'b', show_if: 'a == "y"' })])).toEqual([expect.stringMatching(/circle/)]);
    expect(msgs([F('text', { name: 'a', show_if: 'a == "x"' })])).toEqual([expect.stringMatching(/circle/)]);
  });
  it('a correct setup has no problems', () => {
    expect(msgs([F('number', { name: 'qty' }), F('number', { name: 'price' }), F('formula', { name: 'net', formula: 'qty * price' }), F('text', { show_if: 'net > 1000' })])).toEqual([]);
  });
});

describe('single-field setup (fieldOptionsProblem)', () => {
  it('names: small letters, digits, _; only on fields with a value', () => {
    expect(fieldOptionsProblem('number', { name: 'Qty' })).toMatch(/small letter/);
    expect(fieldOptionsProblem('number', { name: '1qty' })).toMatch(/small letter/);
    expect(fieldOptionsProblem('number', { name: 'unit_price_2' })).toBeNull();
    expect(fieldOptionsProblem('note', { name: 'n', text: 'x' })).toMatch(/Only fields/);
    expect(fieldOptionsProblem('signature', { name: 's' })).toMatch(/Only fields/);
  });
  it('a calculated field needs a valid formula; a condition must be valid and not on a signature', () => {
    expect(fieldOptionsProblem('formula', {})).toMatch(/Formula: Type a formula/);
    expect(fieldOptionsProblem('formula', { formula: 'qty *' })).toMatch(/Formula: .*ends too early/);
    expect(fieldOptionsProblem('formula', { formula: 'qty * price' })).toBeNull();
    expect(fieldOptionsProblem('text', { show_if: 'plan = "x"' })).toMatch(/Condition: .*==/);
    expect(fieldOptionsProblem('signature', { show_if: 'true' })).toMatch(/always shown/);
    expect(fieldOptionsProblem('initials', { show_if: 'true' })).toMatch(/always shown/);
    expect(fieldOptionsProblem('text', { show_if: 'plan == "Yearly"' })).toBeNull();
  });
});

describe('properties', () => {
  const names = ['a', 'b', 'c', 'd'];
  const exprSrc = fc.oneof(
    fc.constantFrom(...names),
    fc.tuple(fc.constantFrom(...names), fc.constantFrom('+', '-', '*', '/', '>', '==', 'and'), fc.oneof(fc.constantFrom(...names), fc.integer({ min: -5, max: 5 }).map(String))).map((t) => t.join(' ')),
    fc.constantFrom('1 / 0', 'not a', 'if(a > 1, b, c)', 'round(a * 1.005, 2)', '"x" == a', 'a +'),
  );
  const fieldArb = fc.record({
    type: fc.constantFrom<FieldType>('number', 'text', 'checkbox', 'formula'),
    name: fc.option(fc.constantFrom(...names), { nil: undefined }),
    formula: exprSrc,
    show_if: fc.option(exprSrc, { nil: undefined }),
    recipient: fc.constantFrom('r1', 'r2'),
  });
  const valueArb = fc.oneof(fc.constant(''), fc.constant('true'), fc.integer({ min: -1000, max: 1000 }).map(String), fc.constantFrom('12.50', 'abc'));

  it('never throws, is deterministic, and a hidden field never has a computed value', () => {
    fc.assert(
      fc.property(fc.array(fieldArb, { maxLength: 8 }), fc.array(valueArb, { minLength: 8, maxLength: 8 }), (specs, vals) => {
        const fields: LogicField[] = specs.map((s, i) => ({
          id: `p${i}`,
          type: s.type,
          recipient_id: s.recipient,
          options: { ...(s.name ? { name: s.name } : {}), ...(s.type === 'formula' ? { formula: s.formula } : {}), ...(s.show_if ? { show_if: s.show_if } : {}) },
        }));
        const valueOf = (id: string) => vals[Number(id.slice(1))] ?? '';
        logicProblems(fields); // never throws, even with duplicates and circles
        const a = computeForm(fields, valueOf);
        const b = computeForm(fields, valueOf);
        expect([...a.hidden].sort()).toEqual([...b.hidden].sort());
        expect([...a.computed.entries()]).toEqual([...b.computed.entries()]);
        for (const id of a.hidden) expect(a.computed.has(id)).toBe(false);
        for (const [, c] of a.computed) if (c.ok) expect(c.value).toMatch(/^-?\d+\.\d{2}$/);
      }),
      { numRuns: 3000 },
    );
  });
});
