'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg';

export function UploadForm() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const choose = (f: File | undefined | null) => {
    setError(null);
    if (!f) return setFile(null);
    if (f.size > MAX_BYTES) {
      setFile(null);
      return setError('That file is larger than 10 MB. Reduce its size and try again.');
    }
    setFile(f);
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/envelopes/upload', { method: 'POST', body });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? 'The upload did not complete. Nothing was saved. Try again.');
        setBusy(false);
        return;
      }
      router.push(`/app/envelopes/${data.id}`);
    } catch {
      setError('The upload did not complete. Check your connection and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          choose(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors duration-150 ${over ? 'border-periwinkle-ink bg-surface-lavender' : 'border-control-border bg-surface'}`}
      >
        <p className="text-lg text-ink">Drop a file here, or choose one</p>
        <p className="mt-1 text-sm text-ink-muted">PDF, PNG or JPG · up to 10 MB · up to 100 pages</p>
        <input ref={input} id="file" type="file" accept={ACCEPT} className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
        <div className="mt-4">
          <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            Choose file
          </Button>
        </div>
        <p className="mt-4 text-sm text-ink-body" aria-live="polite">
          {file ? `Selected: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)` : 'No file selected yet.'}
        </p>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div>
        <Button type="button" onClick={upload} disabled={!file || busy}>
          {busy ? 'Checking and uploading…' : 'Upload and continue'}
        </Button>
      </div>
    </div>
  );
}
