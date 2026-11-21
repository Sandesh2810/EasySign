// Formula and condition language (Phase 4 slice 4, AT4.4, D-79): examples and property tests.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { EMPTY, ExprError, LIMITS, evaluate, formatDecimal, parse, parseDecimal, print, refs, roundScaled, toNumber, type Expr, type Val } from './expr';

const vals = (m: Record<string, string | number | boolean | null>) => (name: string): Val => {
  if (!(name in m)) throw new ExprError(`unknown ${name}`);
  const v = m[name];
  if (v === null) return EMPTY;
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') return { t: 'num', v: parseDecimal(String(v))! };
  return { t: 'str', v };
};
const calc = (src: string, m: Record<string, string | number | boolean | null> = {}, decimals = 2) => {
  return formatDecimal(toNumber(evaluate(parse(src), vals(m))), decimals);
};
const test = (src: string, m: Record<string, string | number | boolean | null> = {}) => {
  const r = evaluate(parse(src), vals(m));
  return r.t === 'bool' ? r.v : r;
};

describe('arithmetic is exact decimal, rounded only at the end', () => {
  it('0.10 + 0.20 is exactly 0.30, not 0.30000000000000004', () => {
    expect(calc('0.10 + 0.20')).toBe('0.30');
    expect(calc('a + b', { a: 0.1, b: 0.2 }, 6)).toBe('0.300000');
    expect(test('0.1 + 0.2 == 0.3')).toBe(true);
  });
  it('precedence and brackets', () => {
    expect(calc('2 + 3 * 4')).toBe('14.00');
    expect(calc('(2 + 3) * 4')).toBe('20.00');
    expect(calc('10 - 4 - 3')).toBe('3.00');
    expect(calc('100 / 4 / 5')).toBe('5.00');
    expect(calc('-2 * 3')).toBe('-6.00');
    expect(calc('- -5', {}, 0)).toBe('5');
  });
  it('quantity times unit price, with VAT, to the cent', () => {
    expect(calc('qty * unit_price', { qty: 3, unit_price: 19.99 })).toBe('59.97');
    expect(calc('round(qty * unit_price * 1.2, 2)', { qty: 3, unit_price: 19.99 })).toBe('71.96');
    expect(calc('1 / 3', {}, 2)).toBe('0.33');
    expect(calc('2 / 3', {}, 2)).toBe('0.67');
  });
  it('rounds half away from zero (2.345 -> 2.35, -2.345 -> -2.35)', () => {
    expect(calc('round(2.345, 2)')).toBe('2.35');
    expect(calc('round(-2.345, 2)')).toBe('-2.35');
    expect(calc('round(2.344, 2)')).toBe('2.34');
    expect(calc('round(2.5)', {}, 0)).toBe('3');
    expect(calc('round(-2.5)', {}, 0)).toBe('-3');
    expect(formatDecimal(parseDecimal('-0.004')!, 2)).toBe('0.00'); // never "-0.00"
  });
  it('min, max, abs, if', () => {
    expect(calc('min(3, 1, 2)')).toBe('1.00');
    expect(calc('max(3, 1, 2)')).toBe('3.00');
    expect(calc('abs(-7.5)')).toBe('7.50');
    expect(calc('if(qty > 10, 0.9, 1) * 100', { qty: 11 })).toBe('90.00');
    expect(calc('if(qty > 10, 0.9, 1) * 100', { qty: 10 })).toBe('100.00');
  });
  it('if() only evaluates the branch it picks, so a guard against division by zero works', () => {
    expect(calc('if(qty == 0, 0, total / qty)', { qty: 0, total: 50 })).toBe('0.00');
    expect(calc('if(qty == 0, 0, total / qty)', { qty: 4, total: 50 })).toBe('12.50');
  });
  it('an empty field counts as 0 in a sum; a number typed as text still adds', () => {
    expect(calc('a + b', { a: 5, b: null })).toBe('5.00');
    expect(calc('a + b', { a: '5.25', b: 1 })).toBe('6.25');
  });
});

describe('conditions', () => {
  it('compare numbers, text and ticks', () => {
    expect(test('plan == "Yearly"', { plan: 'Yearly' })).toBe(true);
    expect(test("plan != 'Yearly'", { plan: 'Monthly' })).toBe(true);
    expect(test('agree', { agree: true })).toBe(true);
    expect(test('agree == true', { agree: true })).toBe(true);
    expect(test('amount >= 1000', { amount: '1000.00' })).toBe(true);
    expect(test('amount > 1000 and plan == "Yearly"', { amount: 2000, plan: 'Monthly' })).toBe(false);
    expect(test('amount > 1000 or plan == "Yearly"', { amount: 2000, plan: 'Monthly' })).toBe(true);
    expect(test('not agree', { agree: true })).toBe(false);
    expect(test('!(a == 1) && b == 2 || c == 3', { a: 1, b: 2, c: 3 })).toBe(true);
    expect(test('company == ""', { company: null })).toBe(true); // an empty field equals empty text
  });
  it('field names are case-insensitive and reported by refs()', () => {
    expect([...refs(parse('Qty * Unit_Price + if(agree, fee, 0)'))].sort()).toEqual(['agree', 'fee', 'qty', 'unit_price']);
  });
});

describe('mistakes get a plain-language reason, never a crash', () => {
  const reason = (src: string) => {
    try {
      parse(src);
      return 'parsed';
    } catch (e) {
      expect(e).toBeInstanceOf(ExprError);
      return (e as Error).message;
    }
  };
  it('refuses broken formulas at parse time', () => {
    expect(reason('')).toMatch(/Type a formula/);
    expect(reason('qty = 1')).toMatch(/==/);
    expect(reason('(1 + 2')).toMatch(/closing bracket/);
    expect(reason('1 + ')).toMatch(/ends too early/);
    expect(reason('qty 2')).toMatch(/operator/);
    expect(reason('a < b < c')).toMatch(/two things at a time/);
    expect(reason('"open')).toMatch(/closing quote/);
    expect(reason('round(1, 2, 3)')).toMatch(/round\(\) takes 1 to 2/);
    expect(reason('if(a, b)')).toMatch(/if\(\) takes 3/);
    expect(reason('qty ; drop')).toMatch(/";" cannot be used/);
    expect(reason('1.2.3')).toMatch(/"\." cannot be used/);
    expect(reason('qty "x"')).toMatch(/"x" is not expected/);
    expect(reason('1234567890123456')).toMatch(/not a number this can use/);
    expect(reason('and + 1')).toMatch(/"and" cannot be used/);
    expect(reason('constructor.prototype')).toMatch(/cannot be used/);
  });
  it('refuses oversized input (length, tokens, nesting)', () => {
    expect(reason('1+'.repeat(160) + '1')).toMatch(/under 300|too long/);
    expect(reason('a+'.repeat(100) + 'a')).toMatch(/too long/);
    expect(reason('('.repeat(40) + '1' + ')'.repeat(40))).toMatch(/brackets/);
    expect(reason('-'.repeat(40) + '1')).toMatch(/brackets/);
  });
  it('refuses at evaluation: division by zero, text in a sum, too large, bad round()', () => {
    expect(() => calc('a / b', { a: 1, b: 0 })).toThrow(/Division by zero/);
    expect(() => calc('a / b', { a: 1, b: null })).toThrow(/Division by zero/);
    expect(() => calc('a + 1', { a: 'ten' })).toThrow(/needs numbers/);
    expect(() => calc('999999999999999 * 999999999999999')).toThrow(/too large/);
    expect(() => calc('round(1.234, 2.5)')).toThrow(/0 to 6/);
    expect(() => calc('round(1.234, 7)')).toThrow(/0 to 6/);
  });
  it('uses no eval, no Function and no dynamic import', () => {
    const src = readFileSync(new URL('./expr.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\beval\s*\(|\bFunction\s*\(|new\s+Function|import\s*\(/);
  });
});

// ---------- property tests ----------
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'round', 'min', 'max', 'abs', 'if']);
const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/).filter((s) => !KEYWORDS.has(s));
const scaled = fc.bigInt({ min: 0n, max: 10n ** 15n * 10n ** 6n - 1n });
const text = fc.string({ maxLength: 8 }).filter((s) => !s.includes('"') && !s.includes("'"));
const BIN_OPS = ['+', '-', '*', '/', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'] as const;

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: 'small', maxDepth: 4 },
    scaled.map((v): Expr => ({ k: 'num', v })),
    text.map((v): Expr => ({ k: 'str', v })),
    fc.boolean().map((v): Expr => ({ k: 'bool', v })),
    name.map((n): Expr => ({ k: 'ref', name: n })),
    fc.record({ op: fc.constantFrom('-' as const, 'not' as const), x: tie('e') }).map((r): Expr => ({ k: 'unary', ...r })),
    fc.record({ op: fc.constantFrom(...BIN_OPS), a: tie('e'), b: tie('e') }).map((r): Expr => ({ k: 'bin', ...r })),
    fc.oneof(
      fc.record({ fn: fc.constantFrom('min' as const, 'max' as const), args: fc.array(tie('e'), { minLength: 1, maxLength: 3 }) }),
      fc.record({ fn: fc.constant('abs' as const), args: fc.tuple(tie('e')) }),
      fc.record({ fn: fc.constant('round' as const), args: fc.oneof(fc.tuple(tie('e')), fc.tuple(tie('e'), tie('e'))) }),
      fc.record({ fn: fc.constant('if' as const), args: fc.tuple(tie('e'), tie('e'), tie('e')) }),
    ).map((r): Expr => ({ k: 'call', fn: r.fn, args: [...r.args] as Expr[] })),
  ),
})).e;

const isSizeLimit = (e: unknown) => e instanceof ExprError && /under 300|too long|brackets/.test(e.message);

describe('properties', () => {
  it('print then parse gives the same expression back (round trip)', () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        let back: Expr;
        try {
          back = parse(print(e));
        } catch (err) {
          if (isSizeLimit(err)) return fc.pre(false);
          throw err;
        }
        expect(back).toEqual(e);
      }),
      { numRuns: 2000 },
    );
  });

  it('any text either parses or gives a plain ExprError; never another kind of failure', () => {
    const alphabet = fc.constantFrom(...'abc_xyz019. +-*/()<>=!,"\'&|andortrueifminmax'.split(''));
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 400 }), fc.array(alphabet, { maxLength: 120 }).map((a) => a.join(''))), (src) => {
        try {
          const e = parse(src);
          try {
            evaluate(e, () => ({ t: 'num', v: 1_000_000n }));
          } catch (err) {
            expect(err).toBeInstanceOf(ExprError);
          }
        } catch (err) {
          expect(err).toBeInstanceOf(ExprError);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('evaluating any well-formed expression terminates with a value or an ExprError', () => {
    const val: fc.Arbitrary<Val> = fc.oneof(
      fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }).map((v): Val => ({ t: 'num', v })),
      text.map((v): Val => ({ t: 'str', v })),
      fc.boolean().map((v): Val => ({ t: 'bool', v })),
      fc.constant(EMPTY),
    );
    fc.assert(
      fc.property(exprArb, fc.dictionary(name, val), val, (e, env, fallback) => {
        try {
          const r = evaluate(e, (n) => env[n] ?? fallback);
          expect(['num', 'str', 'bool', 'empty']).toContain(r.t);
        } catch (err) {
          expect(err).toBeInstanceOf(ExprError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  const cents = fc.bigInt({ min: -(10n ** 11n), max: 10n ** 11n });
  const centsText = (c: bigint) => {
    const neg = c < 0n;
    const a = neg ? -c : c;
    return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  };

  it('a column of money amounts adds up exactly to the cent (BigInt reference)', () => {
    fc.assert(
      fc.property(fc.array(cents, { minLength: 1, maxLength: 20 }), (cs) => {
        const env: Record<string, string> = {};
        cs.forEach((c, i) => (env[`v${i}`] = centsText(c)));
        const src = cs.map((_, i) => `v${i}`).join(' + ');
        expect(calc(src, env)).toBe(centsText(cs.reduce((a, b) => a + b, 0n)));
      }),
      { numRuns: 1000 },
    );
  });

  it('quantity times price is exact; adding is order-independent', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000n }), cents, cents, (q, p, r) => {
        expect(calc('q * p', { q: q.toString(), p: centsText(p) })).toBe(centsText(q * p));
        expect(calc('p + r', { p: centsText(p), r: centsText(r) })).toBe(calc('r + p', { p: centsText(p), r: centsText(r) }));
        expect(calc('(p + r) - r', { p: centsText(p), r: centsText(r) })).toBe(centsText(p));
      }),
      { numRuns: 1000 },
    );
  });

  it('rounding to cents is half away from zero, matching an integer reference', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (micro) => {
        // reference: micro-units -> cents, half away from zero
        const neg = micro < 0n;
        const a = neg ? -micro : micro;
        const c = (a + 5_000n) / 10_000n;
        const refCents = neg ? -c : c;
        expect(formatDecimal(micro, 2)).toBe(centsText(refCents).replace(/^-(0\.00)$/, '$1'));
        expect(roundScaled(micro, 2) % 10_000n).toBe(0n);
      }),
      { numRuns: 2000 },
    );
  });

  it('parseDecimal and formatDecimal are inverses at six places', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 21n) + 1n, max: 10n ** 21n - 1n }), (v) => {
        expect(parseDecimal(formatDecimal(v, 6))).toBe(v);
      }),
      { numRuns: 2000 },
    );
  });

  it(`limits hold: nothing over ${LIMITS.chars} characters is accepted`, () => {
    fc.assert(
      fc.property(fc.integer({ min: LIMITS.chars + 1, max: 2000 }), (n) => {
        expect(() => parse('1'.padEnd(n, ' '))).toThrow(ExprError);
      }),
      { numRuns: 50 },
    );
  });
});
