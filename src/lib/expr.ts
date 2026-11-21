// Formula and condition language (Phase 4 slice 4, AT4.4, D-79). A small hand-written tokenizer, parser and evaluator:
// no eval, no Function, no regular expressions over the whole input, hard limits on size and nesting.
//
//   numbers 12, 12.50      text "Yearly" or 'Yearly'      true false
//   field names: qty, unit_price (the "Name" a sender gives a field)
//   + - * /  unary -       == != < <= > >=       and or not  (also && || !)
//   round(x, n)  min(a, b, ...)  max(a, b, ...)  abs(x)  if(condition, then, else)
//
// Numbers are exact decimals: whole numbers scaled by 10^6 (BigInt). Adding and subtracting are exact; multiplying and
// dividing round half away from zero to 6 places; results are rounded to the field's decimals (2 = cents) only at the
// end. So 0.10 + 0.20 is exactly 0.30, and a column of prices adds up to the cent.
// No browser or Node imports: the same file runs on the signer page, in the server and in the sealing worker.

export const SCALE_DIGITS = 6;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const MAX_ABS = 10n ** 15n * SCALE; // a quadrillion: far beyond any contract value, small enough to stay fast
export const LIMITS = { chars: 300, tokens: 150, depth: 25 } as const;

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

export type Val = { t: 'num'; v: bigint } | { t: 'str'; v: string } | { t: 'bool'; v: boolean } | { t: 'empty' };
export const EMPTY: Val = { t: 'empty' };

export type Expr =
  | { k: 'num'; v: bigint }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; name: string }
  | { k: 'unary'; op: '-' | 'not'; x: Expr }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { k: 'call'; fn: Fn; args: Expr[] };
type BinOp = '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
type Fn = 'round' | 'min' | 'max' | 'abs' | 'if';
const FUNCTIONS: Record<Fn, [min: number, max: number]> = { round: [1, 2], min: [1, 20], max: [1, 20], abs: [1, 1], if: [3, 3] };

// ---------- decimals ----------
/** "12.50" -> 12500000n (scaled), or null if it is not a plain decimal. */
export function parseDecimal(s: string): bigint | null {
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(SCALE_DIGITS, '0');
  const v = BigInt(m[2]) * SCALE + BigInt(frac);
  return m[1] === '-' ? -v : v;
}

/** Round a scaled value to `decimals` places, half away from zero, and print it ("12.50"). */
export function formatDecimal(v: bigint, decimals: number): string {
  const d = Math.max(0, Math.min(SCALE_DIGITS, Math.trunc(decimals)));
  const r = roundScaled(v, d);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(SCALE_DIGITS, '0').slice(0, d);
  return `${neg && (whole !== 0n || /[1-9]/.test(frac)) ? '-' : ''}${whole}${d ? `.${frac}` : ''}`;
}

/** Round half away from zero to `d` decimal places; the result is still scaled by 10^6. */
export function roundScaled(v: bigint, d: number): bigint {
  const unit = 10n ** BigInt(SCALE_DIGITS - d);
  return divRound(v, unit) * unit;
}

/** a / b rounded half away from zero (b != 0). */
function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const aa = a < 0n ? -a : a;
  const bb = b < 0n ? -b : b;
  const q = (aa * 2n + bb) / (bb * 2n);
  return neg ? -q : q;
}

function checkRange(v: bigint): bigint {
  if (v > MAX_ABS || v < -MAX_ABS) throw new ExprError('The result is too large.');
  return v;
}

// ---------- tokens ----------
type Tok = { k: 'num'; v: bigint } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string };

function tokenize(src: string): Tok[] {
  if (src.length > LIMITS.chars) throw new ExprError(`Keep it under ${LIMITS.chars} characters.`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      if (src[j] === '.') {
        j += 1;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      const v = parseDecimal(src.slice(i, j));
      if (v === null) throw new ExprError(`"${src.slice(i, j)}" is not a number this can use (up to 15 digits and 6 decimals).`);
      out.push({ k: 'num', v });
      i = j;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError('A piece of text is missing its closing quote.');
      out.push({ k: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ k: 'id', v: src.slice(i, j).toLowerCase() });
      i = j;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        out.push({ k: 'op', v: two });
        i += 2;
      } else if ('+-*/()<>!,'.includes(c)) {
        out.push({ k: 'op', v: c });
        i += 1;
      } else if (c === '=') {
        throw new ExprError('Use == to compare (a single = is not allowed).');
      } else {
        throw new ExprError(`"${c}" cannot be used here.`);
      }
    }
    if (out.length > LIMITS.tokens) throw new ExprError('That is too long. Split it into smaller formulas.');
  }
  return out;
}

// ---------- parser (precedence climbing) ----------
const BIN: Record<string, { op: BinOp; prec: number }> = {
  or: { op: 'or', prec: 1 }, '||': { op: 'or', prec: 1 },
  and: { op: 'and', prec: 2 }, '&&': { op: 'and', prec: 2 },
  '==': { op: '==', prec: 4 }, '!=': { op: '!=', prec: 4 },
  '<': { op: '<', prec: 4 }, '<=': { op: '<=', prec: 4 }, '>': { op: '>', prec: 4 }, '>=': { op: '>=', prec: 4 },
  '+': { op: '+', prec: 5 }, '-': { op: '-', prec: 5 },
  '*': { op: '*', prec: 6 }, '/': { op: '/', prec: 6 },
};
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', ...Object.keys(FUNCTIONS)]);

/** Parse a formula or condition. Throws ExprError with a plain-language reason. */
export function parse(src: string): Expr {
  const toks = tokenize(src);
  if (!toks.length) throw new ExprError('Type a formula.');
  let pos = 0;
  const peek = () => toks[pos];
  const word = (t: Tok | undefined) => (t?.k === 'op' || t?.k === 'id' ? t.v : '');
  const expect = (v: string) => {
    if (word(peek()) !== v) throw new ExprError(v === ')' ? 'A closing bracket ) is missing.' : `Expected "${v}".`);
    pos += 1;
  };

  const expr = (minPrec: number, depth: number): Expr => {
    if (depth > LIMITS.depth) throw new ExprError('Too many brackets inside each other.');
    let left = unary(depth);
    for (;;) {
      const b = BIN[word(peek())];
      if (!b || b.prec < minPrec) return left;
      pos += 1;
      // comparisons do not chain (a < b < c is refused); everything else is left-associative
      const right = expr(b.prec + 1, depth + 1);
      if (b.prec === 4 && BIN[word(peek())]?.prec === 4) throw new ExprError('Compare two things at a time; join comparisons with "and".');
      left = { k: 'bin', op: b.op, a: left, b: right };
    }
  };
  const unary = (depth: number): Expr => {
    if (depth > LIMITS.depth) throw new ExprError('Too many brackets inside each other.');
    const w = word(peek());
    if (w === '-') {
      pos += 1;
      return { k: 'unary', op: '-', x: unary(depth + 1) };
    }
    if (w === 'not' || w === '!') {
      pos += 1;
      return { k: 'unary', op: 'not', x: expr(3, depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth: number): Expr => {
    const t = peek();
    if (!t) throw new ExprError('The formula ends too early.');
    pos += 1;
    if (t.k === 'num') return { k: 'num', v: t.v };
    if (t.k === 'str') return { k: 'str', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const e = expr(1, depth + 1);
      expect(')');
      return e;
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v in FUNCTIONS) {
        const fn = t.v as Fn;
        expect('(');
        const args: Expr[] = [];
        if (word(peek()) !== ')') {
          for (;;) {
            args.push(expr(1, depth + 1));
            if (word(peek()) === ',') {
              pos += 1;
              continue;
            }
            break;
          }
        }
        expect(')');
        const [min, max] = FUNCTIONS[fn];
        if (args.length < min || args.length > max) throw new ExprError(`${fn}() takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? '' : 's'}.`);
        return { k: 'call', fn, args };
      }
      if (KEYWORDS.has(t.v)) throw new ExprError(`"${t.v}" cannot be used here.`);
      return { k: 'ref', name: t.v };
    }
    throw new ExprError(`"${t.v}" cannot be used here.`);
  };

  const e = expr(1, 0);
  if (pos < toks.length) {
    const t = toks[pos];
    const shown = t.k === 'num' ? formatDecimal(t.v, SCALE_DIGITS).replace(/\.?0+$/, '') : t.v;
    throw new ExprError(`"${shown}" is not expected here: an operator such as + or * may be missing.`);
  }
  return e;
}

/** Field names a formula or condition reads. */
export function refs(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case 'ref':
      out.add(e.name);
      break;
    case 'unary':
      refs(e.x, out);
      break;
    case 'bin':
      refs(e.a, out);
      refs(e.b, out);
      break;
    case 'call':
      e.args.forEach((a) => refs(a, out));
      break;
  }
  return out;
}

/** Canonical text of an expression (fully bracketed): parse(print(e)) gives e back. */
export function print(e: Expr): string {
  switch (e.k) {
    case 'num':
      return formatDecimal(e.v, SCALE_DIGITS).replace(/\.?0+$/, '') || '0';
    case 'str':
      return e.v.includes('"') ? `'${e.v}'` : `"${e.v}"`;
    case 'bool':
      return String(e.v);
    case 'ref':
      return e.name;
    case 'unary':
      return e.op === '-' ? `(-${print(e.x)})` : `(not ${print(e.x)})`;
    case 'bin':
      return `(${print(e.a)} ${e.op} ${print(e.b)})`;
    case 'call':
      return `${e.fn}(${e.args.map(print).join(', ')})`;
  }
}

// ---------- evaluation ----------
export const truthy = (v: Val): boolean => (v.t === 'bool' ? v.v : v.t === 'num' ? v.v !== 0n : v.t === 'str' ? v.v !== '' : false);

/** A formula's result as a number (a formula can be just one field name, whose value is text). Throws ExprError. */
export const toNumber = (v: Val): bigint => num(v, 'A formula');

function num(v: Val, what: string): bigint {
  if (v.t === 'num') return v.v;
  if (v.t === 'empty') return 0n; // an empty field counts as 0 in a sum
  if (v.t === 'bool') return v.v ? SCALE : 0n;
  const p = parseDecimal(v.v);
  if (p !== null) return p;
  throw new ExprError(`${what} needs numbers, but got text.`);
}

/** Evaluate with `lookup` giving each field name's current value. Throws ExprError (division by zero, text in a sum, ...). */
export function evaluate(e: Expr, lookup: (name: string) => Val): Val {
  switch (e.k) {
    case 'num':
      return { t: 'num', v: e.v };
    case 'str':
      return { t: 'str', v: e.v };
    case 'bool':
      return { t: 'bool', v: e.v };
    case 'ref':
      return lookup(e.name);
    case 'unary': {
      const x = evaluate(e.x, lookup);
      return e.op === '-' ? { t: 'num', v: -num(x, 'A minus sign') } : { t: 'bool', v: !truthy(x) };
    }
    case 'bin': {
      if (e.op === 'and') return { t: 'bool', v: truthy(evaluate(e.a, lookup)) && truthy(evaluate(e.b, lookup)) };
      if (e.op === 'or') return { t: 'bool', v: truthy(evaluate(e.a, lookup)) || truthy(evaluate(e.b, lookup)) };
      const a = evaluate(e.a, lookup);
      const b = evaluate(e.b, lookup);
      switch (e.op) {
        case '+':
          return { t: 'num', v: checkRange(num(a, 'Adding') + num(b, 'Adding')) };
        case '-':
          return { t: 'num', v: checkRange(num(a, 'Subtracting') - num(b, 'Subtracting')) };
        case '*':
          return { t: 'num', v: checkRange(divRound(num(a, 'Multiplying') * num(b, 'Multiplying'), SCALE)) };
        case '/': {
          const d = num(b, 'Dividing');
          if (d === 0n) throw new ExprError('Division by zero.');
          return { t: 'num', v: checkRange(divRound(num(a, 'Dividing') * SCALE, d)) };
        }
        default:
          return { t: 'bool', v: compare(e.op, a, b) };
      }
    }
    case 'call': {
      // if() evaluates only the branch it picks: if(qty == 0, 0, total / qty) must not divide by zero
      if (e.fn === 'if') return evaluate(truthy(evaluate(e.args[0], lookup)) ? e.args[1] : e.args[2], lookup);
      const args = e.args.map((x) => evaluate(x, lookup));
      switch (e.fn) {
        case 'abs': {
          const v = num(args[0], 'abs()');
          return { t: 'num', v: v < 0n ? -v : v };
        }
        case 'round': {
          const p = args[1] === undefined ? 0n : num(args[1], 'round()');
          if (p % SCALE !== 0n || p < 0n || p > BigInt(SCALE_DIGITS) * SCALE) throw new ExprError('round() keeps 0 to 6 decimal places.');
          const places = Number(p / SCALE);
          return { t: 'num', v: roundScaled(num(args[0], 'round()'), places) };
        }
        case 'min':
        case 'max': {
          const ns = args.map((a) => num(a, `${e.fn}()`));
          return { t: 'num', v: ns.reduce((m, x) => ((e.fn === 'min' ? x < m : x > m) ? x : m)) };
        }
      }
    }
  }
}

function compare(op: BinOp, a: Val, b: Val): boolean {
  // numbers (and empty fields, as 0) compare as numbers when both sides read as numbers
  const an = a.t === 'num' ? a.v : a.t === 'empty' ? 0n : a.t === 'str' ? parseDecimal(a.v) : null;
  const bn = b.t === 'num' ? b.v : b.t === 'empty' ? 0n : b.t === 'str' ? parseDecimal(b.v) : null;
  if (an !== null && bn !== null && (a.t === 'num' || b.t === 'num')) {
    return op === '==' ? an === bn : op === '!=' ? an !== bn : op === '<' ? an < bn : op === '<=' ? an <= bn : op === '>' ? an > bn : an >= bn;
  }
  if (a.t === 'bool' || b.t === 'bool') {
    const eq = truthy(a) === truthy(b);
    return op === '==' ? eq : op === '!=' ? !eq : false;
  }
  const as = a.t === 'str' ? a.v : a.t === 'empty' ? '' : String(a.v);
  const bs = b.t === 'str' ? b.v : b.t === 'empty' ? '' : String(b.v);
  return op === '==' ? as === bs : op === '!=' ? as !== bs : op === '<' ? as < bs : op === '<=' ? as <= bs : op === '>' ? as > bs : as >= bs;
}
