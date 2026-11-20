'use client';
// Field editor: shows the original PDF with pdf.js and lets the sender place, move, resize and remove
// fields. Positions are stored as fractions of the page as displayed (see src/lib/geometry.ts), so
// they are independent of zoom and screen size. This is part of the neutral signing surface: plain
// colours, no decoration.
import { useCallback, useEffect, useRef, useState } from 'react';
import { clampRect, FIELD_DEFAULT_SIZE, FIELD_LABEL, FIELD_TYPES, fieldOptionsProblem, type FieldOptions, type FieldType } from '@/lib/fields';
import { FieldSettings, defaultOptions } from './field-settings';
import { saveFieldsAction } from '../actions';

export interface EditorField {
  key: string;
  /** the signer this field belongs to */
  recipientId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  /** fixed by the template it came from: cannot be moved, resized or removed (the database refuses it too, D-77) */
  locked?: boolean;
  /** choices, limits, note text, link, text check (D-78) */
  options?: FieldOptions;
}

interface PageInfo {
  /** displayed size in PDF points (after rotation and crop) */
  width: number;
  height: number;
}

interface Props {
  envelopeId: string;
  documentId: string;
  /** the people who sign, in turn order; each field belongs to one of them */
  signers: { id: string; name: string }[];
  initialFields: EditorField[];
  readOnly: boolean;
}

/** One outline and tint per signer. Never colour alone: each field also carries the signer's name. */
const TONES = [
  { border: '#4e57b8', bg: '#c9cdf3' },
  { border: '#8a5a00', bg: '#f6e3b4' },
  { border: '#1f6f5c', bg: '#c4e8dd' },
  { border: '#9b2f6e', bg: '#f1cfe3' },
  { border: '#4a4a4a', bg: '#dcdcdc' },
];

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
const MAX_WIDTH = 900;
let nextKey = 0;
const newKey = () => `f${Date.now().toString(36)}${(nextKey++).toString(36)}`;

export function FieldEditor({ envelopeId, documentId, signers, initialFields, readOnly }: Props) {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fields, setFields] = useState<EditorField[]>(initialFields);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [width, setWidth] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const pdfRef = useRef<unknown>(null);
  const history = useRef<{ past: EditorField[][]; future: EditorField[][] }>({ past: [], future: [] });
  const clipboard = useRef<EditorField | null>(null);
  const [activeSigner, setActiveSigner] = useState<string | null>(signers[0]?.id ?? null);
  const canEdit = !readOnly && signers.length > 0;
  const signerName = (id: string) => signers.find((x) => x.id === id)?.name ?? 'Signer';
  const toneOf = (id: string) => TONES[Math.max(0, signers.findIndex((x) => x.id === id)) % TONES.length];

  // ---- container width (re-render pages when it changes) ----
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(el.clientWidth, MAX_WIDTH));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- load the document once ----
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
        const loading = pdfjs.getDocument({ url: `/api/envelopes/${envelopeId}/document`, standardFontDataUrl: '/pdfjs/standard_fonts/', enableXfa: false });
        task = loading;
        const pdf = await loading.promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        const infos: PageInfo[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
          infos.push({ width: vp.width, height: vp.height });
        }
        if (!cancelled) setPages(infos);
      } catch {
        if (!cancelled) setLoadError('The document could not be displayed. Reload the page to try again.');
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [envelopeId]);

  // ---- draw pages ----
  useEffect(() => {
    const pdf = pdfRef.current as { getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: object) => { promise: Promise<void>; cancel: () => void } }> } | null;
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

  // ---- editing with undo/redo ----
  const commit = useCallback((next: EditorField[]) => {
    setFields((prev) => {
      history.current.past.push(prev);
      if (history.current.past.length > 100) history.current.past.shift();
      history.current.future = [];
      return next;
    });
    setSave('dirty');
  }, []);
  const undo = useCallback(() => {
    setFields((prev) => {
      const past = history.current.past.pop();
      if (!past) return prev;
      history.current.future.push(prev);
      setSave('dirty');
      return past;
    });
  }, []);
  const redo = useCallback(() => {
    setFields((prev) => {
      const next = history.current.future.pop();
      if (!next) return prev;
      history.current.past.push(prev);
      setSave('dirty');
      return next;
    });
  }, []);

  // ---- autosave ----
  useEffect(() => {
    if (save !== 'dirty') return;
    const timer = setTimeout(async () => {
      setSave('saving');
      const snapshot = fields;
      const payload = snapshot.map((f) => ({ document_id: documentId, recipient_id: f.recipientId, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, options: f.options ?? {} }));
      const res = await saveFieldsAction(envelopeId, payload).catch(() => ({ ok: false as const, message: 'Could not reach the server. Your changes are not saved yet.' }));
      setFields((current) => {
        // if the user kept editing while we saved, stay dirty so the newer layout is saved too
        setSave(!res.ok ? 'error' : current === snapshot ? 'saved' : 'dirty');
        return current;
      });
      setSaveMessage(res.ok ? '' : res.message);
    }, 700);
    return () => clearTimeout(timer);
  }, [save, fields, documentId, envelopeId]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save === 'dirty' || save === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save]);

  // ---- placing ----
  /** Place the chosen field with its centre at (cx, cy), as fractions of the page. */
  const placeCentredAt = (pageIndex: number, cx: number, cy: number) => {
    if (!canEdit || !tool || !activeSigner) return null;
    const size = FIELD_DEFAULT_SIZE[tool];
    const w = size.w / pages[pageIndex].width;
    const h = size.h / pages[pageIndex].height;
    const r = clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
    const f: EditorField = { key: newKey(), recipientId: activeSigner, type: tool, page: pageIndex + 1, required: tool !== 'note' && tool !== 'hyperlink', options: defaultOptions(tool), ...r };
    commit([...fields, f]);
    setSelected(f.key);
    setTool(null);
    return f;
  };
  const placeAt = (pageIndex: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    placeCentredAt(pageIndex, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };
  // Keyboard (and one-click) way to place a field: a free spot down the left side of the page, then the arrow keys
  // or the Move buttons put it where it belongs (WCAG 2.1.1, slice 9). Focus moves to the new field.
  const placeFromButton = (pageIndex: number) => {
    const onPage = fields.filter((f) => f.page === pageIndex + 1).length;
    const f = placeCentredAt(pageIndex, 0.3, 0.12 + ((onPage * 0.08) % 0.8));
    if (f) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-field-key="${f.key}"]`)?.focus());
  };

  // ---- drag and resize ----
  const drag = useRef<{ key: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: EditorField; pageW: number; pageH: number; before: EditorField[]; moved: boolean } | null>(null);
  const onPointerDown = (f: EditorField, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!canEdit) return;
    e.stopPropagation();
    setSelected(f.key);
    if (f.locked) return; // fixed by the template: selectable, never dragged
    const pageEl = (e.currentTarget as HTMLElement).closest('[data-page]') as HTMLElement;
    const pr = pageEl.getBoundingClientRect();
    drag.current = { key: f.key, mode, startX: e.clientX, startY: e.clientY, orig: f, pageW: pr.width, pageH: pr.height, before: fields, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.pageW;
    const dy = (e.clientY - d.startY) / d.pageH;
    if (Math.abs(dx) + Math.abs(dy) > 0.002) d.moved = true;
    const r = d.mode === 'move' ? clampRect({ ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy }) : clampRect({ ...d.orig, w: Math.min(d.orig.w + dx, 1 - d.orig.x), h: Math.min(d.orig.h + dy, 1 - d.orig.y) });
    setFields((prev) => prev.map((f) => (f.key === d.key ? { ...f, ...r } : f)));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    history.current.past.push(d.before);
    history.current.future = [];
    setSave('dirty');
  };

  // ---- keyboard ----
  const onFieldKey = (f: EditorField) => (e: React.KeyboardEvent) => {
    if (!canEdit) return;
    if (f.locked && (e.key.startsWith('Arrow') || e.key === 'Delete' || e.key === 'Backspace')) return;
    const step = e.shiftKey ? 0.02 : 0.005;
    const move = (dx: number, dy: number) => {
      e.preventDefault();
      commit(fields.map((x) => (x.key === f.key ? { ...x, ...clampRect({ ...x, x: x.x + dx, y: x.y + dy }) } : x)));
    };
    if (e.key === 'ArrowLeft') move(-step, 0);
    else if (e.key === 'ArrowRight') move(step, 0);
    else if (e.key === 'ArrowUp') move(0, -step);
    else if (e.key === 'ArrowDown') move(0, step);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      commit(fields.filter((x) => x.key !== f.key));
      setSelected(null);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      clipboard.current = f;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicate(f);
    }
  };
  // Move or resize with single clicks: the alternative to dragging that WCAG 2.5.7 asks for (slice 9).
  const adjust = (f: EditorField, dx: number, dy: number, dw: number, dh: number) =>
    commit(fields.map((x) => (x.key === f.key ? { ...x, ...clampRect({ x: x.x + dx, y: x.y + dy, w: Math.min(x.w + dw, 1 - x.x), h: Math.min(x.h + dh, 1 - x.y) }) } : x)));
  const duplicate = (f: EditorField) => {
    const copy: EditorField = { ...f, key: newKey(), locked: false, ...clampRect({ ...f, x: f.x + 0.02, y: f.y + 0.02 }) };
    commit([...fields, copy]);
    setSelected(copy.key);
  };
  const onEditorKey = (e: React.KeyboardEvent) => {
    if (!canEdit) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 'v' && clipboard.current) {
      e.preventDefault();
      duplicate(clipboard.current);
    } else if (e.key === 'Escape') {
      setTool(null);
      setSelected(null);
    }
  };

  const statusText = { saved: 'All changes saved', dirty: 'Saving…', saving: 'Saving…', error: saveMessage || 'Not saved' }[save];
  const sel = fields.find((f) => f.key === selected) ?? null;

  return (
    <div className="signing-surface rounded-lg border border-[#c8c5bd]" onKeyDown={onEditorKey}>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[#c8c5bd] bg-white px-3 py-2">
        {readOnly ? (
          <p className="py-1 text-sm text-[#373330]">This document has been sent. Fields can no longer be changed.</p>
        ) : signers.length === 0 ? (
          <p className="py-1 text-sm text-[#373330]">Add and save at least one person who signs (step 1), then place their fields on the document.</p>
        ) : (
          <>
            <span className="text-sm text-[#373330]" id="tool-hint">
              {tool ? `Click on the page to place: ${FIELD_LABEL[tool]}` : signers.length === 1 ? `Fields for ${signers[0].name}:` : 'Fields for'}
            </span>
            {signers.length > 1 ? (
              <select
                aria-label="New fields are for this signer"
                value={activeSigner ?? ''}
                onChange={(e) => {
                  setActiveSigner(e.target.value);
                  setSelected(null);
                }}
                className="min-h-9 max-w-[14rem] rounded-md border-2 bg-white px-2 text-sm text-[#1a1818]"
                style={{ borderColor: activeSigner ? toneOf(activeSigner).border : '#8a857d' }}
              >
                {signers.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            ) : null}
            {FIELD_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tool === t}
                onClick={() => setTool(tool === t ? null : t)}
                className={`min-h-9 rounded-md border px-3 text-sm ${tool === t ? 'border-[#1a1818] bg-[#1a1818] text-white' : 'border-[#8a857d] bg-white text-[#1a1818] hover:bg-[#f5f4ef]'}`}
              >
                {FIELD_LABEL[t]}
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-[#c8c5bd]" aria-hidden />
            <button type="button" onClick={undo} className="min-h-9 rounded-md border border-[#8a857d] px-3 text-sm text-[#1a1818]">
              Undo
            </button>
            <button type="button" onClick={redo} className="min-h-9 rounded-md border border-[#8a857d] px-3 text-sm text-[#1a1818]">
              Redo
            </button>
            {sel?.locked ? (
              <>
                <span className="text-sm text-[#373330]">This field is fixed by the template: it cannot be moved, resized, reassigned or removed.</span>
                <button type="button" onClick={() => duplicate(sel)} className="min-h-9 rounded-md border border-[#8a857d] px-3 text-sm text-[#1a1818]">
                  Duplicate
                </button>
              </>
            ) : sel ? (
              <>
                {signers.length > 1 ? (
                  <label className="flex items-center gap-1 text-sm text-[#373330]">
                    Belongs to
                    <select
                      value={sel.recipientId}
                      onChange={(e) => commit(fields.map((x) => (x.key === sel.key ? { ...x, recipientId: e.target.value } : x)))}
                      className="min-h-9 max-w-[12rem] rounded-md border-2 bg-white px-2 text-sm text-[#1a1818]"
                      style={{ borderColor: toneOf(sel.recipientId).border }}
                    >
                      {signers.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <span role="group" aria-label="Move or resize the selected field" className="flex flex-wrap items-center gap-1">
                  {(
                    [
                      ['←', 'Move left', -0.01, 0, 0, 0],
                      ['→', 'Move right', 0.01, 0, 0, 0],
                      ['↑', 'Move up', 0, -0.01, 0, 0],
                      ['↓', 'Move down', 0, 0.01, 0, 0],
                      ['Wider', 'Wider', 0, 0, 0.02, 0],
                      ['Narrower', 'Narrower', 0, 0, -0.02, 0],
                      ['Taller', 'Taller', 0, 0, 0, 0.01],
                      ['Shorter', 'Shorter', 0, 0, 0, -0.01],
                    ] as const
                  ).map(([text, label, dx, dy, dw, dh]) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={label}
                      title={label}
                      onClick={() => adjust(sel, dx, dy, dw, dh)}
                      className="min-h-9 min-w-9 rounded-md border border-[#8a857d] px-2 text-sm text-[#1a1818]"
                    >
                      {text}
                    </button>
                  ))}
                </span>
                <button type="button" onClick={() => duplicate(sel)} className="min-h-9 rounded-md border border-[#8a857d] px-3 text-sm text-[#1a1818]">
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    commit(fields.filter((x) => x.key !== sel.key));
                    setSelected(null);
                  }}
                  className="min-h-9 rounded-md border border-[#a8412c] px-3 text-sm text-[#a8412c]"
                >
                  Remove
                </button>
                <div className="basis-full">
                  <FieldSettings
                    key={sel.key}
                    field={sel}
                    problem={fieldOptionsProblem(sel.type, sel.options ?? {})}
                    onChange={(patch) => commit(fields.map((x) => (x.key === sel.key ? { ...x, ...patch } : x)))}
                  />
                </div>
              </>
            ) : null}
          </>
        )}
        <span role="status" aria-live="polite" className={`ml-auto text-sm ${save === 'error' ? 'text-[#a8412c]' : 'text-[#5e5a55]'}`}>
          {canEdit ? statusText : ''}
        </span>
      </div>

      <div ref={wrap} className="flex flex-col items-center gap-4 bg-[#eceae4] p-3 sm:p-4">
        {loadError ? <p role="alert" className="py-10 text-sm text-[#a8412c]">{loadError}</p> : null}
        {!loadError && pages.length === 0 ? <p className="py-10 text-sm text-[#5e5a55]">Loading document…</p> : null}
        {pages.map((p, i) => (
          <div key={i} className="w-full" style={{ maxWidth: MAX_WIDTH }}>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <p className="text-xs text-[#5e5a55]">
                Page {i + 1} of {pages.length}
              </p>
              {tool && canEdit ? (
                <button type="button" onClick={() => placeFromButton(i)} className="min-h-9 rounded-md border border-[#1a1818] bg-white px-3 text-sm text-[#1a1818]">
                  Place {FIELD_LABEL[tool]} on page {i + 1}
                </button>
              ) : null}
            </div>
            <div
              data-page={i + 1}
              onClick={(e) => placeAt(i, e)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="relative w-full select-none bg-white shadow-sm"
              style={{ aspectRatio: `${p.width} / ${p.height}`, cursor: tool && canEdit ? 'crosshair' : 'default' }}
            >
              <canvas
                ref={(el) => {
                  canvases.current[i] = el;
                }}
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-label={`Page ${i + 1} of the document`}
                role="img"
              />
              {fields
                .filter((f) => f.page === i + 1)
                .map((f) => {
                  const isSel = f.key === selected;
                  const visible = `${FIELD_LABEL[f.type]}${signers.length > 1 ? ` · ${signerName(f.recipientId)}` : ''}${f.locked ? ' · locked' : ''}`;
                  const howTo = f.locked ? 'Fixed by the template: it cannot be moved or removed.' : 'Arrow keys or the Move buttons move it, Delete removes it.';
                  return (
                    <div
                      key={f.key}
                      data-field-key={f.key}
                      role="button"
                      tabIndex={0}
                      // Starts with the words shown on the box (WCAG 2.5.3, slice 9).
                      aria-label={`${visible} field${signers.length > 1 ? '' : ` for ${signerName(f.recipientId)}`} on page ${f.page}. ${howTo}`}
                      aria-pressed={isSel}
                      onPointerDown={onPointerDown(f, 'move')}
                      onKeyDown={onFieldKey(f)}
                      onFocus={() => setSelected(f.key)}
                      className={`absolute flex items-center overflow-hidden border-2 border-dashed px-1 text-[11px] font-medium leading-tight text-[#1a1818] ${isSel ? 'outline outline-2 outline-offset-1 outline-[#1a1818]' : ''}`}
                      style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, cursor: canEdit && !f.locked ? 'move' : 'default', touchAction: 'none', borderColor: toneOf(f.recipientId).border, backgroundColor: `${toneOf(f.recipientId).bg}${isSel ? 'dd' : '99'}` }}
                    >
                      <span className="truncate">{visible}</span>
                      {isSel && canEdit && !f.locked ? (
                        <span
                          onPointerDown={onPointerDown(f, 'resize')}
                          aria-hidden
                          className="absolute bottom-0 right-0 h-3.5 w-3.5 translate-x-1/2 translate-y-1/2 rounded-sm border border-white bg-[#1d2044]"
                          style={{ cursor: 'nwse-resize', touchAction: 'none' }}
                        />
                      ) : null}
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
