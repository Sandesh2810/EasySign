'use client';
// Settings of the selected field in the editor (Phase 4 slice 3, D-78): required or not, choices, number limits,
// note text, link, and the check for typed text. Inputs save when you leave them (not on every key press), so undo
// stays useful. The database checks the same settings again when the document is sent.
import { type ReactNode } from 'react';
import { FIELD_LABEL, INFO_ONLY, NAMEABLE, TEXT_CHECKS, type FieldOptions, type FieldType, type TextCheck } from '@/lib/fields';
import type { EditorField } from './field-editor';

const INPUT = 'min-h-9 rounded-md border border-[#8a857d] bg-white px-2 text-sm text-[#1a1818]';
const LABEL = 'flex flex-col gap-1 text-sm text-[#373330]';
const AUTO_OR_ALWAYS: readonly FieldType[] = ['signature', 'initials', 'date_signed', 'name', 'email'];
const CHECK_LABEL: Record<TextCheck, string> = { digits: 'Digits only', letters: 'Letters only', email: 'Email address', phone: 'Phone number', custom: 'Custom pattern' };

export function defaultOptions(type: FieldType): FieldOptions {
  if (type === 'radio' || type === 'dropdown') return { choices: ['Option 1', 'Option 2'] };
  return {};
}

/** Drop empty settings so the stored options stay small and clean. */
function clean(o: FieldOptions): FieldOptions {
  const out: FieldOptions = {};
  for (const [k, v] of Object.entries(o) as [keyof FieldOptions, unknown][]) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  if (!out.check) {
    delete out.pattern;
    delete out.message;
  } else if (out.check !== 'custom') delete out.pattern;
  return out;
}

export function FieldSettings({ field, problem, names = [], onChange }: { field: EditorField; problem: string | null; names?: string[]; onChange: (patch: Partial<EditorField>) => void }) {
  const o = field.options ?? {};
  const set = (patch: FieldOptions) => onChange({ options: clean({ ...o, ...patch }) });
  const num = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
  const id = (name: string) => `fs-${field.key}-${name}`;
  const rows: ReactNode[] = [];

  if (!AUTO_OR_ALWAYS.includes(field.type) && !INFO_ONLY.includes(field.type)) {
    rows.push(
      <label key="req" className="flex items-center gap-2 text-sm text-[#1a1818]">
        <input type="checkbox" checked={field.required} onChange={(e) => onChange({ required: e.target.checked })} className="size-4 accent-[#1a1818]" />
        Required
      </label>,
    );
  }
  if (field.type === 'radio' || field.type === 'dropdown') {
    rows.push(
      <label key="choices" htmlFor={id('choices')} className={LABEL}>
        Choices, one per line (2 to 20)
        <textarea
          id={id('choices')}
          rows={4}
          defaultValue={(o.choices ?? []).join('\n')}
          onBlur={(e) => set({ choices: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20) })}
          className={`${INPUT} min-w-[14rem] py-1`}
        />
      </label>,
    );
  }
  if (field.type === 'number') {
    rows.push(
      <div key="num" className="flex flex-wrap gap-3">
        <label htmlFor={id('min')} className={LABEL}>
          Smallest
          <input id={id('min')} type="number" step="any" defaultValue={o.min ?? ''} onBlur={(e) => set({ min: num(e.target.value) })} className={`${INPUT} w-28`} />
        </label>
        <label htmlFor={id('max')} className={LABEL}>
          Largest
          <input id={id('max')} type="number" step="any" defaultValue={o.max ?? ''} onBlur={(e) => set({ max: num(e.target.value) })} className={`${INPUT} w-28`} />
        </label>
        <label htmlFor={id('dec')} className={LABEL}>
          Decimal places
          <select id={id('dec')} value={o.decimals ?? 2} onChange={(e) => set({ decimals: Number(e.target.value) })} className={INPUT}>
            <option value={0}>0 (whole numbers)</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
      </div>,
    );
  }
  if (field.type === 'note') {
    rows.push(
      <label key="note" htmlFor={id('note')} className={LABEL}>
        Note shown to the signer and printed on the document (up to 500 characters)
        <textarea id={id('note')} rows={3} maxLength={500} defaultValue={o.text ?? ''} onBlur={(e) => set({ text: e.target.value.trim() })} className={`${INPUT} min-w-[16rem] py-1`} />
      </label>,
    );
  }
  if (field.type === 'hyperlink') {
    rows.push(
      <div key="link" className="flex flex-wrap gap-3">
        <label htmlFor={id('url')} className={LABEL}>
          Web address
          <input id={id('url')} type="url" placeholder="https://" maxLength={500} defaultValue={o.url ?? ''} onBlur={(e) => set({ url: e.target.value.trim() })} className={`${INPUT} w-64`} />
        </label>
        <label htmlFor={id('label')} className={LABEL}>
          Link text (optional)
          <input id={id('label')} maxLength={60} defaultValue={o.label ?? ''} onBlur={(e) => set({ label: e.target.value.trim() })} className={`${INPUT} w-48`} />
        </label>
      </div>,
    );
  }
  if (field.type === 'text' || field.type === 'company' || field.type === 'title') {
    rows.push(
      <div key="check" className="flex flex-wrap gap-3">
        <label htmlFor={id('check')} className={LABEL}>
          Check what is typed
          <select id={id('check')} value={o.check ?? ''} onChange={(e) => set({ check: (e.target.value || undefined) as TextCheck | undefined })} className={INPUT}>
            <option value="">No check</option>
            {TEXT_CHECKS.map((c) => (
              <option key={c} value={c}>
                {CHECK_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        {o.check === 'custom' ? (
          <label htmlFor={id('pattern')} className={LABEL}>
            Pattern (regular expression)
            <input id={id('pattern')} maxLength={100} defaultValue={o.pattern ?? ''} onBlur={(e) => set({ pattern: e.target.value })} className={`${INPUT} w-56 font-mono`} />
          </label>
        ) : null}
        {o.check ? (
          <label htmlFor={id('message')} className={LABEL}>
            Message if it does not match (optional)
            <input id={id('message')} maxLength={120} defaultValue={o.message ?? ''} onBlur={(e) => set({ message: e.target.value.trim() })} className={`${INPUT} w-64`} />
          </label>
        ) : null}
      </div>,
    );
  }
  // D-79: name, formula, condition
  if (field.type === 'formula') {
    rows.push(
      <div key="formula" className="flex flex-wrap gap-3">
        <label htmlFor={id('formula')} className={LABEL}>
          Formula, using field names
          <input id={id('formula')} maxLength={300} placeholder="qty * unit_price" defaultValue={o.formula ?? ''} onBlur={(e) => set({ formula: e.target.value.trim() })} className={`${INPUT} w-72 font-mono`} />
        </label>
        <label htmlFor={id('fdec')} className={LABEL}>
          Decimal places
          <select id={id('fdec')} value={o.decimals ?? 2} onChange={(e) => set({ decimals: Number(e.target.value) })} className={INPUT}>
            <option value={0}>0</option>
            <option value={1}>1</option>
            <option value={2}>2 (cents)</option>
          </select>
        </label>
      </div>,
    );
  }
  if (NAMEABLE.includes(field.type)) {
    rows.push(
      <label key="name" htmlFor={id('name')} className={LABEL}>
        Name for formulas (optional)
        <input
          id={id('name')}
          maxLength={31}
          placeholder="e.g. qty"
          defaultValue={o.name ?? ''}
          onBlur={(e) => set({ name: e.target.value.trim().toLowerCase().replace(/\s+/g, '_') || undefined })}
          className={`${INPUT} w-40 font-mono`}
        />
      </label>,
    );
  }
  if (field.type !== 'signature' && field.type !== 'initials') {
    rows.push(
      <label key="showif" htmlFor={id('showif')} className={LABEL}>
        Show only if (optional)
        <input id={id('showif')} maxLength={300} placeholder={'plan == "Yearly"'} defaultValue={o.show_if ?? ''} onBlur={(e) => set({ show_if: e.target.value.trim() || undefined })} className={`${INPUT} w-60 font-mono`} />
      </label>,
    );
  }
  if (field.type === 'formula' || o.show_if || o.name) {
    rows.push(
      <p key="exprhelp" className="basis-full text-sm text-[#373330]">
        Use + − * / and brackets, comparisons (== != &lt; &gt; &lt;= &gt;=), and, or, not, and round(x, 2), min, max, abs, if(test, a, b). Text goes in quotes. Only this signer&apos;s fields can be used.{' '}
        {names.length ? <>Names you can use: <span className="font-mono">{names.join(', ')}</span>.</> : 'Give other fields of this signer a name to use them here.'}
      </p>,
    );
  }
  if (field.type === 'attachment') {
    rows.push(
      <p key="att" className="text-sm text-[#373330]">
        The signer uploads a PDF, PNG or JPG file of up to 5 MB.
      </p>,
    );
  }
  if (!rows.length && !problem) return null;
  return (
    <div role="group" aria-label={`Settings of the selected ${FIELD_LABEL[field.type].toLowerCase()} field`} className="mt-2 flex flex-wrap items-end gap-4 border-t border-[#e4e1da] pt-2">
      {rows}
      {problem ? (
        <p role="status" className="text-sm font-medium text-[#a8412c]">
          Not ready to send: {problem.charAt(0).toLowerCase() + problem.slice(1)}
        </p>
      ) : null}
    </div>
  );
}
