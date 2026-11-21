'use client';
// An attachment field on the signer's page (Phase 4 slice 3, D-78): a button that opens the file chooser, uploads the
// file to /api/sign/attachment and then shows its name. The server checks the type (by content), the size and the field.
import { useRef, useState, type CSSProperties } from 'react';
import { useT } from '@/i18n/client';

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
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const name = value ? value.split(' · SHA-256 ')[0] : '';

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      onError(t('attach.tooBig'));
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
    else onError(t('attach.failed', { error: data?.error ?? t('attach.failedDefault') }));
  };

  return (
    <>
      <button
        type="button"
        ref={setTarget}
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label={value ? t('attach.replace', { name }) : required ? t('attach.addRequired') : t('attach.addOptional')}
        style={{ ...style, color: '#141414', backgroundColor: value ? '#ffffff' : '#fff3bf' }}
        className="absolute flex items-center overflow-hidden whitespace-nowrap rounded-sm border-2 border-dashed border-[#141414] px-1 text-left focus-visible:outline-4"
      >
        {busy ? t('attach.uploading') : value ? t('attach.attached', { name }) : t('attach.add')}
      </button>
      <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg" tabIndex={-1} aria-hidden="true" className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
    </>
  );
}
