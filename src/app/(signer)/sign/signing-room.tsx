'use client';
// The signer's view of the document: the pages, the fields assigned to this signer laid over them,
// a progress bar with "Next", and the final "Adopt and Sign" confirmation.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { fieldValueCheck, INFO_ONLY, TYPED_TYPES, type FieldOptions, type FieldType } from '@/lib/fields';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/format';
import { computeForm } from '@/lib/form-logic';
import { AttachmentField } from './attachment-field';
import { approveAction, completeAction, fillFieldAction } from './actions';
import { DeclineControl } from './decline';
import { HandOffControl } from './handoff';
import { PaperCopyControl, WithdrawControl } from './paper-withdraw';
import { SignatureDialog } from './signature-dialog';

export interface RoomField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  value: string;
  /** choices, limits, note text, link, text check (D-78) */
  options: FieldOptions;
}
interface Props {
  title: string;
  senderLine: string;
  signer: { name: string; email: string };
  fields: RoomField[];
  adopted: { signature: boolean; initials: boolean };
  intentText: string;
  /** sign: fill fields and sign. approve: read, then approve or decline. view: read only. */
  mode: 'sign' | 'approve' | 'view';
  /** D-83: the sender lets this person hand their part to someone else */
  allowHandOff?: boolean;
  /** D-84: the person's questions for the sender (rendered above the document) */
  questions?: React.ReactNode;
}
interface PageInfo {
  width: number;
  height: number;
}
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: object) => { promise: Promise<void>; cancel: () => void } }> };

const MAX_WIDTH = 900;
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const noSubscribe = () => () => {};
const isTyped = (t: FieldType) => TYPED_TYPES.includes(t);
/** Saved as soon as they change (a tick, a choice, a file), not when the field is left. */
const isPicked = (t: FieldType) => t === 'checkbox' || t === 'radio' || t === 'dropdown' || t === 'attachment';
const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : null);

export function SigningRoom({ title, senderLine, signer, fields, adopted, intentText, mode, allowHandOff = false, questions = null }: Props) {
  const t = useT();
  const locale = useLocale();
  const label = (type: FieldType) => t(`field.${type}` as MessageKey);
  const router = useRouter();
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [width, setWidth] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, f.value])));
  const [saveError, setSaveError] = useState<string | null>(null);
  /** fields whose last value was refused, with the reason (shown and announced; aria-invalid on the field) */
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [images, setImages] = useState<{ signature: string | null; initials: string | null }>({
    signature: adopted.signature ? '/api/sign/document?part=signature' : null,
    initials: adopted.initials ? '/api/sign/document?part=initials' : null,
  });
  const [dialogKind, setDialogKind] = useState<'signature' | 'initials' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  /** On a phone, the typed field being filled in through the large entry box at the bottom of the screen. */
  const [editing, setEditing] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const pdfRef = useRef<PdfDoc | null>(null);
  const saved = useRef<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.id, f.value])));
  /** the last value sent for each field, saved or still on its way */
  const sent = useRef<Record<string, string>>({});
  const targets = useRef<Record<string, HTMLElement | null>>({});
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const today = useSyncExternalStore(noSubscribe, localDate, () => '');

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(el.clientWidth, MAX_WIDTH));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
        const loading = pdfjs.getDocument({ url: '/api/sign/document', standardFontDataUrl: '/pdfjs/standard_fonts/', enableXfa: false });
        task = loading;
        const pdf = (await loading.promise) as unknown as PdfDoc;
        if (cancelled) return;
        pdfRef.current = pdf;
        const infos: PageInfo[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
          infos.push({ width: vp.width, height: vp.height });
        }
        if (!cancelled) setPages(infos);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, []);

  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || pages.length === 0 || width === 0) return;
    const tasks: Array<{ cancel: () => void }> = [];
    let cancelled = false;
    (async () => {
      for (let i = 0; i < pages.length; i++) {
        const canvas = canvases.current[i];
        if (!canvas || cancelled) continue;
        const page = await pdf.getPage(i + 1);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / pages[i].width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const t = page.render({ canvas, canvasContext: ctx, viewport });
        tasks.push(t);
        await t.promise.catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
      tasks.forEach((t) => t.cancel());
    };
  }, [pages, width]);

  const isDone = useCallback(
    (f: RoomField) => {
      if (f.type === 'signature') return images.signature !== null;
      if (f.type === 'initials') return images.initials !== null;
      if (f.type === 'checkbox') return values[f.id] === 'true';
      if (isTyped(f.type) || isPicked(f.type)) return (values[f.id] ?? '').trim().length > 0;
      return true; // date, name and email are filled in automatically; notes and links are only shown
    },
    [images, values],
  );
  // D-79: conditions and calculations, worked out again on every change (the server repeats this when signing)
  const form = useMemo(
    () => computeForm(fields.map((f) => ({ id: f.id, type: f.type, recipient_id: 'me', page: f.page, options: f.options ?? {} })), (id) => values[id] ?? ''),
    [fields, values],
  );
  const shown = useMemo(() => fields.filter((f) => !form.hidden.has(f.id)), [fields, form]);
  const required = useMemo(
    () => shown.filter((f) => !INFO_ONLY.includes(f.type) && (f.required || f.type === 'signature' || f.type === 'initials')),
    [shown],
  );
  const remaining = useMemo(() => required.filter((f) => !isDone(f)), [required, isDone]);
  const doneCount = required.length - remaining.length;

  const saveValue = async (f: RoomField, override?: string) => {
    const value = (override ?? values[f.id] ?? '').trim();
    // Compare with the last value SENT, not the last one confirmed: saves run one after another, so a quick tick then
    // untick must send both, or the stored value ends up differing from what the signer sees (found in slice 4).
    if ((f.id in sent.current ? sent.current[f.id] : saved.current[f.id]) === value) return;
    // checked here first so the signer sees the sender's own message at once; the server checks it again
    const check = fieldValueCheck(f.type, f.options ?? {}, value);
    if (check) {
      const problem = 'custom' in check ? check.custom : t(`check.${check.key}` as MessageKey, { n: check.n ?? '' });
      setInvalid((m) => ({ ...m, [f.id]: problem }));
      setSaveError(t('room.fieldProblem', { label: label(f.type), problem }));
      return;
    }
    sent.current[f.id] = value;
    const res = await fillFieldAction(f.id, value).catch(() => ({ ok: false as const, message: t('room.saveOffline') }));
    // a failed save may be retried with the same value
    if (!res.ok && sent.current[f.id] === value) delete sent.current[f.id];
    if (res.ok) {
      saved.current[f.id] = value;
      setSaveError(null);
      setInvalid((m) => {
        const { [f.id]: _gone, ...rest } = m;
        void _gone;
        return rest;
      });
    } else {
      setInvalid((m) => ({ ...m, [f.id]: res.message }));
      setSaveError(res.message);
    }
  };
  const pick = (f: RoomField, value: string) => {
    setValues((v) => ({ ...v, [f.id]: value }));
    void saveValue(f, value);
  };

  const goNext = (skip?: string) => {
    const next = remaining.find((f) => f.id !== skip);
    if (!next) return;
    const el = targets.current[next.id];
    // on a phone a typed field is filled in through the large entry box
    if (isTyped(next.type) && window.innerWidth < 640) {
      el?.scrollIntoView({ block: 'center' });
      setEditing(next.id);
      return;
    }
    el?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el?.focus({ preventScroll: true });
  };

  const editingField = editing ? (fields.find((x) => x.id === editing) ?? null) : null;
  const finishEditing = async (andNext: boolean) => {
    if (!editingField) return;
    await saveValue(editingField);
    setEditing(null);
    if (andNext) goNext(editingField.id);
  };

  /** Keyboard and screen-reader users continue where they were: on the field they just signed. */
  const refocusAfterDialog = (kind: 'signature' | 'initials') => {
    const field = fields.find((f) => f.type === kind);
    const el = field ? targets.current[field.id] : null;
    window.setTimeout(() => el?.focus({ preventScroll: true }), 0);
  };

  const openConfirm = () => {
    setFinishError(null);
    setConfirming(true);
  };
  useEffect(() => {
    const d = confirmDialog.current;
    if (confirming && d && !d.open) d.showModal();
  }, [confirming]);

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    setFinishError(null);
    // make sure every typed value has reached the server before completing
    if (mode === 'sign') for (const f of fields) if (isTyped(f.type)) await saveValue(f);
    const res = await (mode === 'approve' ? approveAction() : completeAction(localDate())).catch(() => ({ ok: false as const, message: t('room.finishOffline') }));
    if (!res.ok) {
      setFinishing(false);
      setFinishError(res.message);
      // D-81: another member of the signing group signed first: show the "already completed" page
      if ('code' in res && res.code === 'ES_GROUP_DONE') router.refresh();
      return;
    }
    router.refresh();
  };

  const autoValue = (f: RoomField) => (f.type === 'date_signed' ? today : f.type === 'name' ? signer.name : signer.email);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-20 border-b border-hairline bg-surface px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-ink-muted">{senderLine}</p>
            <h1 className="truncate text-lg font-medium text-ink">{title}</h1>
          </div>
          {mode === 'view' ? (
            <p className="text-sm text-ink-body">{t('room.view')}</p>
          ) : mode === 'approve' ? (
            <div className="flex flex-wrap items-center gap-2">
              <PaperCopyControl className="px-2" />
              <WithdrawControl className="px-2" />
              {allowHandOff ? <HandOffControl className="px-2" /> : null}
              <DeclineControl />
              <Button type="button" onClick={openConfirm}>
                {t('room.approve')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p role="status" className="text-sm text-ink-body">
                {t('room.progress', { done: doneCount, total: required.length })}
              </p>
              <PaperCopyControl className="px-2" />
              <WithdrawControl className="px-2" />
              {allowHandOff ? <HandOffControl className="px-2" /> : null}
              <DeclineControl variant="quiet" className="px-2" />
              {remaining.length > 0 ? (
                <Button type="button" onClick={() => goNext()}>
                  {doneCount === 0 ? t('room.start') : t('room.next')}
                </Button>
              ) : (
                <Button type="button" onClick={openConfirm}>
                  {t('room.finish')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[900px] px-2 py-4 sm:px-4">
        {saveError ? (
          <div className="mb-3">
            <Notice tone="danger">{saveError}</Notice>
          </div>
        ) : null}
        {loadError ? <Notice tone="danger">{t('room.loadError')}</Notice> : null}
        {questions ? <div className="mb-3">{questions}</div> : null}
        {/* The pages below are pictures. The same file, opened in a PDF app, can be read aloud by a screen reader (WCAG 1.1.1, slice 9). */}
        <p className="mb-3 px-2 text-sm text-ink-body">
          <a href="/api/sign/document" target="_blank" rel="noopener">
            {t('room.openPdf')}
          </a>{' '}
          {t('room.openPdfTail')}
        </p>
        <div ref={wrap} className="flex flex-col items-center gap-4">
          {pages.length === 0 && !loadError ? <p className="py-10 text-ink-muted">{t('room.loading')}</p> : null}
          {pages.map((p, i) => (
            <div key={i} className="relative border border-control-border" style={{ width, height: (width * p.height) / p.width, backgroundColor: '#fff' }}>
              <canvas
                ref={(el) => {
                  canvases.current[i] = el;
                }}
                className="absolute inset-0 size-full"
                role="img"
                aria-label={t('room.pageOf', { n: i + 1, total: pages.length })}
              />
              {shown
                .filter((f) => f.page === i + 1)
                .map((f) => {
                  const box = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
                  const px = ((width * p.height) / p.width) * f.h;
                  const fontSize = Math.max(9, Math.min(16, px * 0.55));
                  if (f.type === 'signature' || f.type === 'initials') {
                    const kind = f.type;
                    const src = images[kind];
                    return (
                      <button
                        key={f.id}
                        type="button"
                        ref={(el) => {
                          targets.current[f.id] = el;
                        }}
                        data-field-kind={kind}
                        onClick={() => setDialogKind(kind)}
                        style={{ ...box, color: '#141414', backgroundColor: src ? 'transparent' : '#fff3bf', fontSize }}
                        className="absolute flex items-center justify-center overflow-hidden rounded-sm border-2 border-dashed border-[#141414] font-medium focus-visible:outline-4"
                        // The spoken name starts with the visible words ("Sign here" / "Initial"), so voice control finds it (WCAG 2.5.3).
                        aria-label={src ? (kind === 'signature' ? t('room.signatureInPlace') : t('room.initialsInPlace')) : kind === 'signature' ? t('room.signHereAria') : t('room.initialHereAria')}
                      >
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                        ) : kind === 'signature' ? (
                          t('room.signHere')
                        ) : (
                          t('room.initial')
                        )}
                      </button>
                    );
                  }
                  // D-80: a value the sender filled in and locked is shown, announced as such, and cannot be changed (the database refuses it too)
                  const ro = f.options?.readonly === true;
                  const need = (name: string) => {
                    const base = t(f.required ? 'room.required' : 'room.optional', { label: name });
                    return ro ? t('room.lockedField', { label: base }) : base;
                  };
                  const filled = (values[f.id] ?? '').trim() !== '';
                  if (f.type === 'checkbox') {
                    return (
                      <input
                        key={f.id}
                        type="checkbox"
                        ref={(el) => {
                          targets.current[f.id] = el;
                        }}
                        aria-label={need(label('checkbox'))}
                        checked={values[f.id] === 'true'}
                        disabled={ro}
                        onChange={(e) => pick(f, e.target.checked ? 'true' : '')}
                        style={{ ...box, margin: 0 }}
                        className="absolute accent-[#141414] focus-visible:outline-4"
                      />
                    );
                  }
                  if (f.type === 'radio') {
                    const choices = f.options?.choices ?? [];
                    return (
                      <fieldset key={f.id} style={{ ...box, color: '#141414', fontSize: Math.min(fontSize, 13), backgroundColor: filled ? '#ffffff' : '#fff3bf' }} className="absolute m-0 flex flex-col justify-center gap-0.5 overflow-auto rounded-sm border-2 border-[#141414] px-1">
                        <legend className="sr-only">{need(label('radio'))}</legend>
                        {choices.map((c, i) => (
                          <label key={c} className="flex min-h-6 items-center gap-1.5 leading-tight">
                            <input
                              type="radio"
                              name={`radio-${f.id}`}
                              value={c}
                              checked={values[f.id] === c}
                              disabled={ro}
                              onChange={() => pick(f, c)}
                              ref={(el) => {
                                if (i === 0) targets.current[f.id] = el;
                              }}
                              className="m-0 size-6 shrink-0 accent-[#141414] focus-visible:outline-4"
                            />
                            {c}
                          </label>
                        ))}
                      </fieldset>
                    );
                  }
                  if (f.type === 'dropdown') {
                    return (
                      <select
                        key={f.id}
                        ref={(el) => {
                          targets.current[f.id] = el;
                        }}
                        aria-label={need(label('dropdown'))}
                        value={values[f.id] ?? ''}
                        disabled={ro}
                        onChange={(e) => pick(f, e.target.value)}
                        style={{ ...box, color: '#141414', fontSize, backgroundColor: filled ? '#ffffff' : '#fff3bf' }}
                        className="absolute rounded-sm border-2 border-[#141414] px-1 focus-visible:outline-4"
                      >
                        <option value="">{t('room.choose')}</option>
                        {(f.options?.choices ?? []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    );
                  }
                  if (f.type === 'note') {
                    return (
                      <div key={f.id} role="note" style={{ ...box, color: '#141414', fontSize: Math.min(fontSize, 12) }} className="absolute overflow-auto rounded-sm border border-[#5a5a5a] bg-white px-1 leading-snug">
                        {/* D-80: the note's text with merge fields filled in when the document was sent */}
                        {f.value || f.options?.text}
                      </div>
                    );
                  }
                  if (f.type === 'formula') {
                    const c = form.computed.get(f.id);
                    return (
                      <div
                        key={f.id}
                        style={{ ...box, color: '#141414', fontSize }}
                        className="absolute flex items-center justify-end overflow-hidden whitespace-nowrap rounded-sm border border-[#5a5a5a] bg-[#f3f3f3] px-1 tabular-nums"
                        title={c && !c.ok ? t('room.calcError', { error: c.error }) : t('room.calcTitle')}
                      >
                        <span className="sr-only">{label('formula')}{f.options?.name ? ` ${f.options.name.replace(/_/g, ' ')}` : ''}: </span>
                        {c?.ok ? c.value : '—'}
                      </div>
                    );
                  }
                  if (f.type === 'hyperlink') {
                    const url = safeUrl(f.options?.url);
                    return url ? (
                      <a key={f.id} href={url} target="_blank" rel="noopener noreferrer" style={{ ...box, fontSize }} className="absolute flex items-center overflow-hidden whitespace-nowrap rounded-sm px-1 text-[#1d4ed8] underline">
                        {f.options?.label || url}
                        <span className="sr-only"> {t('room.newTab')}</span>
                      </a>
                    ) : null;
                  }
                  if (f.type === 'attachment') {
                    return (
                      <AttachmentField
                        key={f.id}
                        fieldId={f.id}
                        required={f.required}
                        value={values[f.id] ?? ''}
                        style={{ ...box, fontSize: Math.min(fontSize, 13) }}
                        setTarget={(el) => {
                          targets.current[f.id] = el;
                        }}
                        onSaved={(value) => {
                          saved.current[f.id] = value;
                          setValues((v) => ({ ...v, [f.id]: value }));
                          setSaveError(null);
                        }}
                        onError={setSaveError}
                      />
                    );
                  }
                  if (isTyped(f.type)) {
                    return (
                      <input
                        key={f.id}
                        ref={(el) => {
                          targets.current[f.id] = el;
                        }}
                        aria-label={need(label(f.type))}
                        aria-invalid={invalid[f.id] ? true : undefined}
                        inputMode={f.type === 'number' ? 'decimal' : undefined}
                        placeholder={label(f.type)}
                        value={values[f.id] ?? ''}
                        maxLength={500}
                        readOnly={ro}
                        onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                        onBlur={() => {
                          if (!ro) void saveValue(f);
                        }}
                        // On a narrow screen the field on the page is too small to read or tap: a tap (or Start/Next) opens the
                        // large box instead. Not on focus alone: tabbing onto a field must not move focus elsewhere (WCAG 3.2.1, slice 9).
                        onClick={() => {
                          if (!ro && window.innerWidth < 640) setEditing(f.id);
                        }}
                        title={ro ? t('room.filledBySender') : undefined}
                        style={{ ...box, color: '#141414', backgroundColor: ro ? '#f3f3f3' : (values[f.id] ?? '').trim() ? '#ffffff' : '#fff3bf', fontSize }}
                        className="absolute rounded-sm border-2 border-[#141414] px-1 placeholder:text-[#5a5a5a] focus-visible:outline-4"
                      />
                    );
                  }
                  return (
                    <div
                      key={f.id}
                      style={{ ...box, color: '#141414', fontSize }}
                      className="absolute flex items-center overflow-hidden whitespace-nowrap rounded-sm border border-dashed border-[#5a5a5a] px-1"
                      title={t('room.autoFilled', { label: label(f.type) })}
                    >
                      <span suppressHydrationWarning>{autoValue(f)}</span>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>

      {editingField
        ? (() => {
            const f = editingField;
            const done = (andNext: boolean) => finishEditing(andNext);
            return (
              <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-soft" role="group" aria-labelledby="phone-entry-label">
                <label id="phone-entry-label" htmlFor="phone-entry" className="text-sm font-medium text-ink">
                  {t(f.required ? 'room.required' : 'room.optional', { label: label(f.type) })}
                </label>
                <input
                  id="phone-entry"
                  autoFocus
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  value={values[f.id] ?? ''}
                  maxLength={500}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void done(true);
                    if (e.key === 'Escape') void done(false);
                  }}
                  enterKeyHint="next"
                  className="mt-1.5 min-h-12 w-full rounded-sm border border-control-border bg-surface px-3 text-base text-ink"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => void done(false)}>
                    {t('room.done')}
                  </Button>
                  <Button type="button" onClick={() => void done(true)}>
                    {t('room.next')}
                  </Button>
                </div>
              </div>
            );
          })()
        : null}

      {dialogKind ? (
        <SignatureDialog
          kind={dialogKind}
          signerName={signer.name}
          onClose={() => {
            setDialogKind(null);
            refocusAfterDialog(dialogKind);
          }}
          onAdopted={(url) => {
            setImages((m) => ({ ...m, [dialogKind]: url }));
            setDialogKind(null);
            refocusAfterDialog(dialogKind);
          }}
        />
      ) : null}

      {confirming ? (
        <dialog
          ref={confirmDialog}
          onClose={() => setConfirming(false)}
          aria-labelledby="finish-title"
          className="m-auto w-[min(36rem,calc(100vw-1.5rem))] rounded-lg bg-surface p-0 text-ink shadow-soft backdrop:bg-ink/60"
        >
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <h2 id="finish-title" className="text-xl font-medium text-ink">
              {mode === 'approve' ? t('room.approveTitle') : t('room.signTitle')}
            </h2>
            {/* D-95: the statement stays in reviewed English in every language, and says so */}
            <p lang="en" dir="ltr" className="text-base text-ink-body">
              {intentText}
            </p>
            {locale !== 'en' ? <p className="text-sm text-ink-muted">{t('common.legalAboveInEnglish')}</p> : null}
            <p className="text-sm text-ink-muted">
              {t(mode === 'approve' ? 'room.asApprover' : 'room.asSigner', { name: signer.name, email: signer.email })}
            </p>
            {finishError ? <Notice tone="danger">{finishError}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => confirmDialog.current?.close()} disabled={finishing}>
                {t('common.goBack')}
              </Button>
              <Button type="button" onClick={() => void finish()} disabled={finishing}>
                {finishing ? t('common.oneMoment') : mode === 'approve' ? t('room.approve') : t('room.adopt')}
              </Button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
