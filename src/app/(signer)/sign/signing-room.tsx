'use client';
// The signer's view of the document: the pages, the fields assigned to this signer laid over them,
// a progress bar with "Next", and the final "Adopt and Sign" confirmation.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { FIELD_LABEL, type FieldType } from '@/lib/fields';
import { approveAction, completeAction, fillFieldAction } from './actions';
import { DeclineControl } from './decline';
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
const isTyped = (t: FieldType) => t === 'company' || t === 'title' || t === 'text';

export function SigningRoom({ title, senderLine, signer, fields, adopted, intentText, mode }: Props) {
  const router = useRouter();
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, f.value])));
  const [saveError, setSaveError] = useState<string | null>(null);
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
        if (!cancelled) setLoadError('The document could not be displayed. Reload the page to try again.');
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
      if (isTyped(f.type)) return (values[f.id] ?? '').trim().length > 0;
      return true; // date, name and email are filled in automatically
    },
    [images, values],
  );
  const required = useMemo(() => fields.filter((f) => f.required || f.type === 'signature' || f.type === 'initials'), [fields]);
  const remaining = useMemo(() => required.filter((f) => !isDone(f)), [required, isDone]);
  const doneCount = required.length - remaining.length;

  const saveValue = async (f: RoomField) => {
    const value = (values[f.id] ?? '').trim();
    if (saved.current[f.id] === value) return;
    const res = await fillFieldAction(f.id, value).catch(() => ({ ok: false as const, message: 'We could not reach the server. Your last entry is not saved yet.' }));
    if (res.ok) {
      saved.current[f.id] = value;
      setSaveError(null);
    } else setSaveError(res.message);
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
    const res = await (mode === 'approve' ? approveAction() : completeAction(localDate())).catch(() => ({ ok: false as const, message: 'We could not reach the server. Nothing was recorded. Try again.' }));
    if (!res.ok) {
      setFinishing(false);
      setFinishError(res.message);
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
            <p className="text-sm text-ink-body">For your information. Nothing is needed from you.</p>
          ) : mode === 'approve' ? (
            <div className="flex flex-wrap items-center gap-2">
              <PaperCopyControl className="px-2" />
              <WithdrawControl className="px-2" />
              <DeclineControl />
              <Button type="button" onClick={openConfirm}>
                Approve
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p role="status" className="text-sm text-ink-body">
                {doneCount} of {required.length} done
              </p>
              <PaperCopyControl className="px-2" />
              <WithdrawControl className="px-2" />
              <DeclineControl variant="quiet" className="px-2" />
              {remaining.length > 0 ? (
                <Button type="button" onClick={() => goNext()}>
                  {doneCount === 0 ? 'Start' : 'Next'}
                </Button>
              ) : (
                <Button type="button" onClick={openConfirm}>
                  Finish
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
        {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
        <div ref={wrap} className="flex flex-col items-center gap-4">
          {pages.length === 0 && !loadError ? <p className="py-10 text-ink-muted">Loading the document…</p> : null}
          {pages.map((p, i) => (
            <div key={i} className="relative border border-control-border" style={{ width, height: (width * p.height) / p.width, backgroundColor: '#fff' }}>
              <canvas
                ref={(el) => {
                  canvases.current[i] = el;
                }}
                className="absolute inset-0 size-full"
                role="img"
                aria-label={`Page ${i + 1} of ${pages.length}`}
              />
              {fields
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
                        onClick={() => setDialogKind(kind)}
                        style={{ ...box, color: '#141414', backgroundColor: src ? 'transparent' : '#fff3bf', fontSize }}
                        className="absolute flex items-center justify-center overflow-hidden rounded-sm border-2 border-dashed border-[#141414] font-medium focus-visible:outline-4"
                        aria-label={src ? `Your ${FIELD_LABEL[kind].toLowerCase()} is in place. Change it` : `${FIELD_LABEL[kind]} needed here`}
                      >
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                        ) : kind === 'signature' ? (
                          'Sign here'
                        ) : (
                          'Initial'
                        )}
                      </button>
                    );
                  }
                  if (isTyped(f.type)) {
                    return (
                      <input
                        key={f.id}
                        ref={(el) => {
                          targets.current[f.id] = el;
                        }}
                        aria-label={`${FIELD_LABEL[f.type]}${f.required ? ' (required)' : ' (optional)'}`}
                        placeholder={FIELD_LABEL[f.type]}
                        value={values[f.id] ?? ''}
                        maxLength={500}
                        onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                        onBlur={() => void saveValue(f)}
                        // On a narrow screen the field on the page is too small to read or tap: use the large box instead.
                        onFocus={() => {
                          if (window.innerWidth < 640) setEditing(f.id);
                        }}
                        onClick={() => {
                          if (window.innerWidth < 640) setEditing(f.id);
                        }}
                        style={{ ...box, color: '#141414', backgroundColor: (values[f.id] ?? '').trim() ? '#ffffff' : '#fff3bf', fontSize }}
                        className="absolute rounded-sm border-2 border-[#141414] px-1 placeholder:text-[#5a5a5a] focus-visible:outline-4"
                      />
                    );
                  }
                  return (
                    <div
                      key={f.id}
                      style={{ ...box, color: '#141414', fontSize }}
                      className="absolute flex items-center overflow-hidden whitespace-nowrap rounded-sm border border-dashed border-[#5a5a5a] px-1"
                      title={`${FIELD_LABEL[f.type]} (filled in for you)`}
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
                  {FIELD_LABEL[f.type]}
                  {f.required ? ' (required)' : ' (optional)'}
                </label>
                <input
                  id="phone-entry"
                  autoFocus
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
                    Done
                  </Button>
                  <Button type="button" onClick={() => void done(true)}>
                    Next
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
              {mode === 'approve' ? 'Approve this document' : 'Sign this document'}
            </h2>
            <p className="text-base text-ink-body">{intentText}</p>
            <p className="text-sm text-ink-muted">
              {mode === 'approve' ? 'Approving' : 'Signing'} as {signer.name} ({signer.email}). {mode === 'approve' ? 'After this step your approval cannot be withdrawn here.' : 'After this step the document cannot be changed.'}
            </p>
            {finishError ? <Notice tone="danger">{finishError}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => confirmDialog.current?.close()} disabled={finishing}>
                Go back
              </Button>
              <Button type="button" onClick={() => void finish()} disabled={finishing}>
                {finishing ? 'One moment…' : mode === 'approve' ? 'Approve' : 'Adopt and Sign'}
              </Button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
