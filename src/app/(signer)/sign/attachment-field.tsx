'use client';
// An attachment field on the signer's page (Phase 4 slice 3, D-78): a button that opens the file chooser, uploads the
// file to /api/sign/attachment and then shows its name. The server checks the type (by content), the size and the field.
import { useRef, useState, type CSSProperties } from 'react';

export function AttachmentField({
  fieldId,
  required,
  value,
  style,
  setTarget,
  onSaved,
  onError,
}: {
  fieldId: string;
  required: boolean;
  value: string;
  style: CSSProperties;
  setTarget: (el: HTMLElement | null) => void;
  onSaved: (value: string) => void;
  onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const name = value ? value.split(' · SHA-256 ')[0] : '';

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      onError('Attachment: files can be up to 5 MB.');
      return;
    }
    setBusy(true);
    const body = new FormData();
    body.set('field_id', fieldId);
    body.set('file', file);
    const res = await fetch('/api/sign/attachment', { method: 'POST', body }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { ok?: boolean; value?: string; error?: string } | null;
    setBusy(false);
    if (input.current) input.current.value = '';
    if (res?.ok && data?.ok && data.value) onSaved(data.value);
    else onError(`Attachment: ${data?.error ?? 'the file could not be attached. Try again.'}`);
  };

  return (
    <>
      <button
        type="button"
        ref={setTarget}
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label={value ? `Attached: ${name}. Replace the file` : `Attach a file${required ? ' (required)' : ' (optional)'}`}
        style={{ ...style, color: '#141414', backgroundColor: value ? '#ffffff' : '#fff3bf' }}
        className="absolute flex items-center overflow-hidden whitespace-nowrap rounded-sm border-2 border-dashed border-[#141414] px-1 text-left focus-visible:outline-4"
      >
        {busy ? 'Uploading…' : value ? `Attached: ${name}` : 'Attach a file'}
      </button>
      <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg" tabIndex={-1} aria-hidden="true" className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
    </>
  );
}
