'use client';
// Create a signature or initials: draw it, type it, or upload a picture of it. Whatever the method,
// the browser produces a transparent PNG; the server decodes and re-encodes it before storing it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { adoptSignatureAction } from './actions';

type Method = 'drawn' | 'typed' | 'uploaded';
const W = 1200;
const H = 400;
const INK = '#141414';
const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Snell Roundhand", "Apple Chancery", "Lucida Handwriting", cursive';
const METHODS: { id: Method; label: string }[] = [
  { id: 'drawn', label: 'Draw' },
  { id: 'typed', label: 'Type' },
  { id: 'uploaded', label: 'Upload' },
];

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 4)
    .join('');

export function SignatureDialog({ kind, signerName, onClose, onAdopted }: { kind: 'signature' | 'initials'; signerName: string; onClose: () => void; onAdopted: (previewUrl: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [method, setMethod] = useState<Method>('drawn');
  const [typed, setTyped] = useState(kind === 'signature' ? signerName : initialsOf(signerName));
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noun = kind === 'signature' ? 'signature' : 'initials';

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const clear = useCallback(() => {
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }, []);

  // Typed: redraw whenever the text changes.
  useEffect(() => {
    if (method !== 'typed') return;
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, W, H);
    const text = typed.trim();
    if (!text) return;
    let size = 190;
    do {
      ctx.font = `italic ${size}px ${SCRIPT_FONT}`;
      size -= 6;
    } while (ctx.measureText(text).width > W - 80 && size > 40);
    ctx.fillStyle = INK;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, W / 2, H / 2);
  }, [method, typed]);

  const choose = (m: Method) => {
    clear();
    setHasInk(false);
    setError(null);
    setMethod(m);
  };

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (method !== 'drawn') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = point(e);
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(drawing.current.x, drawing.current.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    setHasInk(true);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const from = drawing.current;
    if (method !== 'drawn' || !from) return;
    const to = point(e);
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    drawing.current = to;
  };
  const up = () => {
    drawing.current = null;
  };

  const onFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Choose a PNG or JPG picture smaller than 5 MB.');
      return;
    }
    try {
      const bmp = await createImageBitmap(file);
      const c = canvas.current;
      const ctx = c?.getContext('2d', { willReadFrequently: true });
      if (!c || !ctx) return;
      ctx.clearRect(0, 0, W, H);
      const scale = Math.min((W - 40) / bmp.width, (H - 40) / bmp.height);
      const w = bmp.width * scale;
      const h = bmp.height * scale;
      ctx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
      // Turn the paper transparent and the pen strokes into dark ink, so the signature can sit on the page.
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const a = (d[i + 3] / 255) * Math.max(0, Math.min(1, (190 - lum) / 110));
        d[i] = 20;
        d[i + 1] = 20;
        d[i + 2] = 20;
        d[i + 3] = Math.round(a * 255);
        if (a > 0.3) ink++;
      }
      ctx.putImageData(img, 0, 0);
      setHasInk(ink > 200);
      if (ink <= 200) setError('We could not find a signature in that picture. Use dark ink on plain white paper, or draw it instead.');
    } catch {
      setError('That picture could not be opened. Try another one, or draw your signature instead.');
    }
  };

  const ready = method === 'typed' ? typed.trim().length > 0 : hasInk;

  const adopt = async () => {
    const c = canvas.current;
    if (!c || !ready || busy) return;
    setBusy(true);
    setError(null);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
    if (!blob) {
      setBusy(false);
      setError('Your browser could not prepare the image. Try again.');
      return;
    }
    const data = new FormData();
    data.set('kind', kind);
    data.set('method', method);
    data.set('typed_text', method === 'typed' ? typed.trim() : '');
    data.set('image', new File([blob], `${kind}.png`, { type: 'image/png' }));
    const res = await adoptSignatureAction(data).catch(() => ({ ok: false as const, message: 'We could not reach the server. Try again.' }));
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onAdopted(URL.createObjectURL(blob));
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="sig-title"
      className="m-auto w-[min(42rem,calc(100vw-1.5rem))] rounded-lg bg-surface p-0 text-ink shadow-soft backdrop:bg-ink/60"
    >
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <h2 id="sig-title" className="text-xl font-medium text-ink">
          Create your {noun}
        </h2>
        <div role="tablist" aria-label={`How to create your ${noun}`} className="flex gap-2">
          {METHODS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={method === m.id}
              onClick={() => choose(m.id)}
              className={`min-h-11 rounded-pill px-5 text-base font-medium ${method === m.id ? 'bg-ink text-on-ink' : 'border border-control-border bg-surface text-ink hover:bg-surface-sand'}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {method === 'typed' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sig-typed" className="text-sm font-medium text-ink">
              Type your {kind === 'signature' ? 'full name' : 'initials'}
            </label>
            <input
              id="sig-typed"
              value={typed}
              maxLength={kind === 'signature' ? 120 : 6}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink"
            />
          </div>
        ) : null}
        {method === 'uploaded' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sig-file" className="text-sm font-medium text-ink">
              Picture of your {noun} (PNG or JPG, dark ink on white paper)
            </label>
            <input id="sig-file" type="file" accept="image/png,image/jpeg" onChange={(e) => void onFile(e.target.files?.[0])} className="text-base text-ink" />
          </div>
        ) : null}
        {method === 'drawn' ? <p className="text-sm text-ink-body">Draw in the box with your finger, a pen or the mouse. Using only a keyboard? Choose Type.</p> : null}

        <canvas
          ref={canvas}
          width={W}
          height={H}
          role="img"
          aria-label={`Preview of your ${noun}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          style={{ backgroundColor: '#fff' }}
          className={`aspect-[3/1] w-full touch-none rounded-sm border-2 border-ink ${method === 'drawn' ? 'cursor-crosshair' : ''}`}
        />

        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {method === 'drawn' ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  clear();
                  setHasInk(false);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void adopt()} disabled={!ready || busy}>
              {busy ? 'Saving…' : `Use this ${noun}`}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
