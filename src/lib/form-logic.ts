// Formulas and conditions across a document's fields (Phase 4 slice 4, AT4.4, D-79).
// One implementation for the editor (send checks), the signer page (live), the server (completing) and the sealing
// worker (the final PDF), so all four agree. No browser or Node imports.
//
// Rules
// * A field may have a name (options.name). Formulas (type 'formula', options.formula) and conditions (options.show_if,
//   on any field except signatures and initials) refer to fields by name.
// * They may only use the same signer's fields: a signer's page never holds another person's answers.
// * No circles: a field's formula and condition may not depend, directly or through others, on the field itself.
// * A hidden field counts as empty for every formula and condition, is never required, and is left out of the sealed PDF.
// * A calculated value is rounded (half away from zero) to the field's decimals, 2 by default: integer cents.
import { EMPTY, ExprError, evaluate, formatDecimal, parse, parseDecimal, refs, toNumber, truthy, type Expr, type Val } from './expr';
import { FIELD_LABEL, fieldOptionsProblem, NAMEABLE, type FieldOptions, type FieldType } from './fields';

export interface LogicField {
  id: string;
  type: FieldType;
  recipient_id: string;
  page?: number;
  options: FieldOptions;
}
export interface LogicProblem {
  fieldId: string;
  message: string;
}
export type Computed = { ok: true; value: string } | { ok: false; error: string };
export interface FormState {
  /** fields whose condition is false: not shown, not required, not sealed */
  hidden: Set<string>;
  /** the value of each visible calculated field, or why it cannot be worked out */
  computed: Map<string, Computed>;
}

const label = (f: LogicField) => (f.options.name ? `"${f.options.name}"` : `the ${FIELD_LABEL[f.type].toLowerCase()} field${f.page ? ` on page ${f.page}` : ''}`);

function tryParse(src: string): Expr | null {
  try {
    return parse(src);
  } catch (e) {
    if (e instanceof ExprError) return null;
    throw e;
  }
}

/** The names a field's formula and condition read (empty when they do not parse; fieldOptionsProblem reports that). */
function depsOf(f: LogicField): string[] {
  const out = new Set<string>();
  for (const src of [f.type === 'formula' ? f.options.formula : undefined, f.options.show_if]) {
    const e = src ? tryParse(src) : null;
    if (e) refs(e, out);
  }
  return [...out];
}

/** Database rows (fields: id, type, recipient_id, page, options) as LogicFields. */
export function toLogicFields(rows: ReadonlyArray<Record<string, unknown>> | null | undefined): LogicField[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    type: r.type as FieldType,
    recipient_id: String(r.recipient_id),
    page: r.page == null ? undefined : Number(r.page),
    options: (r.options ?? {}) as FieldOptions,
  }));
}

/** Everything that stops sending, each as "<which field>: <why>". Used by the editor and by the send action. */
export function sendProblems(fields: LogicField[]): string[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const own = fields.flatMap((f) => {
    const m = fieldOptionsProblem(f.type, f.options);
    return m ? [{ fieldId: f.id, message: m }] : [];
  });
  return [...own, ...logicProblems(fields)].map((p) => {
    const f = byId.get(p.fieldId)!;
    const where = `The ${FIELD_LABEL[f.type].toLowerCase()} field${f.options.name ? ` "${f.options.name}"` : ''}${f.page ? ` on page ${f.page}` : ''}`;
    return `${where}: ${p.message}`;
  });
}

/** Problems that involve more than one field. Single-field problems: fieldOptionsProblem. */
export function logicProblems(fields: LogicField[]): LogicProblem[] {
  const problems: LogicProblem[] = [];
  const byName = new Map<string, LogicField>();
  for (const f of fields) {
    const n = f.options.name;
    if (!n) continue;
    const other = byName.get(n);
    if (other) problems.push({ fieldId: f.id, message: `Another field is already named "${n}". Each name must be different.` });
    else byName.set(n, f);
  }
  for (const f of fields) {
    for (const n of depsOf(f)) {
      const target = byName.get(n);
      if (!target) problems.push({ fieldId: f.id, message: `No field is named "${n}". Give a field that name, or correct the spelling.` });
      else if (target.recipient_id !== f.recipient_id) {
        problems.push({ fieldId: f.id, message: `"${n}" is filled in by another person. Formulas and conditions can only use the same person's fields.` });
      } else if (!NAMEABLE.includes(target.type)) problems.push({ fieldId: f.id, message: `"${n}" has no value a formula can use.` });
    }
  }
  // circles: depth-first search over named dependencies
  const state = new Map<string, 'active' | 'done'>();
  const reported = new Set<string>();
  const visit = (f: LogicField, path: LogicField[]): void => {
    const s = state.get(f.id);
    if (s === 'done') return;
    if (s === 'active') {
      const loop = path.slice(path.indexOf(f));
      if (!reported.has(f.id)) {
        loop.forEach((x) => reported.add(x.id));
        problems.push({ fieldId: f.id, message: `These depend on each other in a circle: ${loop.map(label).join(' → ')} → ${label(f)}.` });
      }
      return;
    }
    state.set(f.id, 'active');
    for (const n of depsOf(f)) {
      const t = byName.get(n);
      if (t && t.recipient_id === f.recipient_id) visit(t, [...path, f]);
    }
    state.set(f.id, 'done');
  };
  fields.forEach((f) => visit(f, []));
  return problems;
}

/**
 * Which fields are hidden and what each calculated field shows, given the stored values (field id -> text; checkbox
 * 'true' or ''). Never throws: a broken formula gives { ok: false } for that field; a condition that cannot be worked
 * out leaves its field shown (showing too much is safe, hiding a required field is not).
 */
export function computeForm(fields: LogicField[], valueOf: (fieldId: string) => string): FormState {
  const byName = new Map<string, LogicField>();
  for (const f of fields) if (f.options.name && !byName.has(f.options.name)) byName.set(f.options.name, f);
  const hiddenMemo = new Map<string, boolean>();
  const formulaMemo = new Map<string, Computed>();
  const busy = new Set<string>(); // circle guard (logicProblems refuses circles at sending; this keeps evaluation finite anyway)

  const lookupFor = (f: LogicField) => (name: string): Val => {
    const t = byName.get(name);
    if (!t || t.recipient_id !== f.recipient_id) throw new ExprError(`No field is named "${name}".`);
    if (isHidden(t)) return EMPTY;
    if (t.type === 'formula') {
      const c = formulaOf(t);
      if (!c.ok) throw new ExprError(`"${name}" cannot be worked out.`);
      return { t: 'num', v: parseDecimal(c.value)! };
    }
    const raw = (valueOf(t.id) ?? '').trim();
    if (t.type === 'checkbox') return { t: 'bool', v: raw === 'true' };
    if (raw === '') return EMPTY;
    if (t.type === 'number') {
      const n = parseDecimal(raw);
      return n === null ? { t: 'str', v: raw } : { t: 'num', v: n };
    }
    return { t: 'str', v: raw };
  };

  function isHidden(f: LogicField): boolean {
    const memo = hiddenMemo.get(f.id);
    if (memo !== undefined) return memo;
    const cond = f.options.show_if;
    let hidden = false;
    if (cond && f.type !== 'signature' && f.type !== 'initials') {
      if (busy.has(f.id)) return false;
      busy.add(f.id);
      try {
        const e = tryParse(cond);
        hidden = e ? !truthy(evaluate(e, lookupFor(f))) : false;
      } catch (err) {
        if (!(err instanceof ExprError)) throw err;
        hidden = false;
      } finally {
        busy.delete(f.id);
      }
    }
    hiddenMemo.set(f.id, hidden);
    return hidden;
  }

  function formulaOf(f: LogicField): Computed {
    const memo = formulaMemo.get(f.id);
    if (memo) return memo;
    if (busy.has(f.id)) return { ok: false, error: 'This calculation depends on itself.' };
    busy.add(f.id);
    let out: Computed;
    try {
      const e = parse(f.options.formula ?? '');
      out = { ok: true, value: formatDecimal(toNumber(evaluate(e, lookupFor(f))), f.options.decimals ?? 2) };
    } catch (err) {
      if (!(err instanceof ExprError)) throw err;
      out = { ok: false, error: err.message };
    } finally {
      busy.delete(f.id);
    }
    formulaMemo.set(f.id, out);
    return out;
  }

  const hidden = new Set<string>();
  const computed = new Map<string, Computed>();
  for (const f of fields) {
    if (isHidden(f)) hidden.add(f.id);
    else if (f.type === 'formula') computed.set(f.id, formulaOf(f));
  }
  return { hidden, computed };
}
