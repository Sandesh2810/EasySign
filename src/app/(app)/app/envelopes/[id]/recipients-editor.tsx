'use client';
// Step 1 on the document page: who is involved, what each person does, and in which order (D-52).
import { useMemo, useState, useTransition } from 'react';
import { Button, Notice } from '@/components/ui';
import { ROLE_LABEL } from '@/lib/recipient-labels';
import { assignOrders, MAX_RECIPIENTS, mustAct, validateRouting, type Role, type RoutingMode } from '@/lib/routing';
import { saveRecipientsAction } from '../actions';

type EditableRole = 'signer' | 'approver' | 'viewer' | 'cc';
export interface EditableRecipient {
  id: string | null;
  name: string;
  email: string;
  role: EditableRole;
  order: number;
}
interface Row extends EditableRecipient {
  key: string;
}

const ROLE_CHOICES: EditableRole[] = ['signer', 'approver', 'viewer', 'cc'];
const MODES: { id: RoutingMode; label: string; help: string }[] = [
  { id: 'sequential', label: 'One after another', help: 'Each person is asked only after the person above them has finished.' },
  { id: 'parallel', label: 'All at once', help: 'Everyone is asked at the same time and can finish in any order.' },
  { id: 'mixed', label: 'Custom order', help: 'Give each person a number. People with the same number go at the same time; higher numbers wait.' },
];
const INPUT = 'min-h-11 w-full rounded-sm border border-control-border bg-surface px-3 text-base text-ink placeholder:text-ink-muted';
let seq = 0;
const newKey = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

/** "1. Boss approves, then 2. Sam and Lee sign. Copy gets the finished document." */
function describe(rows: Row[], orders: number[]): string {
  const acting = rows.map((r, i) => ({ r, order: orders[i] })).filter((x) => mustAct(x.r) && x.r.name.trim());
  if (acting.length === 0) return '';
  const turns = [...new Set(acting.map((x) => x.order))].sort((a, b) => a - b);
  const parts = turns.map((t, i) => {
    const people = acting.filter((x) => x.order === t);
    const names = people.map((x) => `${x.r.name.trim()} (${x.r.role === 'approver' ? 'approves' : 'signs'})`);
    return `${i + 1}. ${names.join(' and ')}`;
  });
  const copies = rows.filter((r) => r.role === 'cc' && r.name.trim()).map((r) => r.name.trim());
  const readers = rows.filter((r) => r.role === 'viewer' && r.name.trim()).map((r) => r.name.trim());
  return [
    parts.join(', then '),
    readers.length ? `${readers.join(' and ')} can read it when their turn comes.` : '',
    copies.length ? `${copies.join(' and ')} ${copies.length === 1 ? 'gets' : 'get'} the finished document.` : '',
  ]
    .filter(Boolean)
    .join('. ')
    .replace(/\.\.+/g, '.');
}

export function RecipientsEditor({ envelopeId, initial, initialMode, me }: { envelopeId: string; initial: EditableRecipient[]; initialMode: RoutingMode; me: { name: string; email: string } }) {
  const [rows, setRows] = useState<Row[]>(() => (initial.length ? initial : [{ id: null, name: '', email: '', role: 'signer' as const, order: 1 }]).map((r) => ({ ...r, key: r.id ?? newKey() })));
  const [mode, setMode] = useState<RoutingMode>(initialMode);
  const [dirty, setDirty] = useState(initial.length === 0);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  const orders = useMemo(() => (mode === 'mixed' ? rows.map((r) => r.order) : assignOrders(mode, rows.map((r) => r.role as Role))), [mode, rows]);
  const summary = useMemo(() => describe(rows, orders), [rows, orders]);
  const meListed = rows.some((r) => r.email.trim().toLowerCase() === me.email.toLowerCase());

  const change = (next: Row[]) => {
    setRows(next);
    setDirty(true);
    setResult(null);
  };
  const patch = (key: string, p: Partial<Row>) => change(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[index], next[to]] = [next[to], next[index]];
    change(next);
  };
  const add = (r: Partial<Row> = {}) => change([...rows, { key: newKey(), id: null, name: '', email: '', role: 'signer', order: Math.max(1, ...orders) + (mode === 'parallel' ? 0 : 1), ...r }]);

  const save = () =>
    start(async () => {
      const filled = rows.filter((r) => r.name.trim() || r.email.trim());
      const check = validateRouting(filled.map((r, i) => ({ id: String(i), role: r.role, order: mode === 'mixed' ? r.order : assignOrders(mode, filled.map((x) => x.role as Role))[i], status: 'created' as const })), mode);
      if (!check.ok) {
        setResult({ ok: false, message: check.message });
        return;
      }
      const res = await saveRecipientsAction(envelopeId, { mode, recipients: filled.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, order: r.order })) }).catch(() => ({ ok: false as const, message: 'Could not reach the server. Nothing was saved.' }));
      setResult({ ok: res.ok, message: res.message ?? 'Saved.' });
      if (res.ok) setDirty(false);
    });

  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="text-sm font-medium text-ink">How do people take turns?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {MODES.map((m) => (
            <label key={m.id} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border px-4 text-sm ${mode === m.id ? 'border-ink bg-ink text-on-ink' : 'border-control-border bg-surface text-ink'}`}>
              <input
                type="radio"
                name="routing-mode"
                value={m.id}
                checked={mode === m.id}
                onChange={() => {
                  if (m.id === 'mixed' && mode !== 'mixed') setRows(rows.map((r, i) => ({ ...r, order: orders[i] })));
                  setMode(m.id);
                  setDirty(true);
                  setResult(null);
                }}
                className="sr-only"
              />
              {m.label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-sm text-ink-muted">{MODES.find((m) => m.id === mode)!.help}</p>
      </fieldset>

      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <li key={r.key} className="rounded-md border border-hairline p-3">
            <div className="grid gap-3 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,11rem)_auto] sm:items-end">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`order-${r.key}`} className="text-sm font-medium text-ink">
                  Turn
                </label>
                {mode === 'mixed' ? (
                  <input id={`order-${r.key}`} type="number" min={1} max={99} value={r.order} onChange={(e) => patch(r.key, { order: Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))) })} className={INPUT} />
                ) : (
                  <output id={`order-${r.key}`} className="flex min-h-11 items-center text-base text-ink">
                    {mustAct({ role: r.role }) || r.role === 'viewer' ? orders[i] : 'End'}
                  </output>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`name-${r.key}`} className="text-sm font-medium text-ink">
                  Name
                </label>
                <input id={`name-${r.key}`} value={r.name} maxLength={120} autoComplete="off" onChange={(e) => patch(r.key, { name: e.target.value })} className={INPUT} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`email-${r.key}`} className="text-sm font-medium text-ink">
                  Email
                </label>
                <input id={`email-${r.key}`} type="email" value={r.email} maxLength={254} autoComplete="off" onChange={(e) => patch(r.key, { email: e.target.value })} className={INPUT} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`role-${r.key}`} className="text-sm font-medium text-ink">
                  What they do
                </label>
                <select id={`role-${r.key}`} value={r.role} onChange={(e) => patch(r.key, { role: e.target.value as EditableRole })} className={INPUT}>
                  {ROLE_CHOICES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${r.name || 'this person'} up`} className="min-h-11 min-w-11 rounded-sm border border-control-border text-ink disabled:opacity-40">
                  ↑
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move ${r.name || 'this person'} down`} className="min-h-11 min-w-11 rounded-sm border border-control-border text-ink disabled:opacity-40">
                  ↓
                </button>
                <button type="button" onClick={() => change(rows.filter((x) => x.key !== r.key))} disabled={rows.length === 1} aria-label={`Remove ${r.name || 'this person'}`} className="min-h-11 min-w-11 rounded-sm border border-control-border text-ink disabled:opacity-40">
                  ✕
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => add()} disabled={rows.length >= MAX_RECIPIENTS}>
          Add a person
        </Button>
        {!meListed ? (
          <Button type="button" variant="outline" onClick={() => (rows.length === 1 && !rows[0].name.trim() && !rows[0].email.trim() ? change([{ ...rows[0], name: me.name, email: me.email }]) : add({ name: me.name, email: me.email }))} disabled={rows.length >= MAX_RECIPIENTS}>
            Add myself
          </Button>
        ) : null}
      </div>

      {summary ? (
        <p className="rounded-md bg-surface-sand px-4 py-3 text-sm text-ink-body">
          <span className="font-medium text-ink">Order: </span>
          {summary}
        </p>
      ) : null}
      {result ? <Notice tone={result.ok ? 'success' : 'danger'}>{result.message}</Notice> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={pending || !dirty}>
          {pending ? 'Saving…' : dirty ? 'Save people' : 'Saved'}
        </Button>
        {dirty ? <span className="text-sm text-ink-muted">Not saved yet. Fields can be placed once the people are saved.</span> : null}
        <span className="text-sm text-ink-muted">If you remove someone who signs, their fields are removed too.</span>
      </div>
    </div>
  );
}
