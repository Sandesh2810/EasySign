'use client';
// D-88 (AT4.8): workspace branding. A live preview shows the band signers will see; an unreadable colour pair is
// explained and cannot be saved (the server and the database refuse it too).
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { brandProblem, contrastRatio, MAX_FOOTER, normaliseColor, TEXT_COLOR, type TextOnBrand } from '@/lib/branding';
import { clearBrandingAction, removeLogoAction, saveBrandingAction, uploadLogoAction } from './branding-actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';

export interface BrandingValues {
  color: string;
  text: TextOnBrand;
  footer: string;
  logoUrl: string | null;
  saved: boolean;
}

export function BrandingForm({ orgId, workspaceName, initial, canEdit }: { orgId: string; workspaceName: string; initial: BrandingValues; canEdit: boolean }) {
  const router = useRouter();
  const [color, setColor] = useState(initial.color);
  const [text, setText] = useState<TextOnBrand>(initial.text);
  const [footer, setFooter] = useState(initial.footer);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const valid = normaliseColor(color);
  const problem = brandProblem(color, text);
  const ratio = valid ? contrastRatio(valid, TEXT_COLOR[text]) : null;
  const preview = { backgroundColor: valid ?? '#FFFFFF', color: TEXT_COLOR[text] };

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const res = await fn().catch(() => ({ ok: false, message: 'Could not reach the server. Nothing was changed.' }));
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });

  if (!canEdit) {
    return <p className="text-sm text-ink-muted">Only the workspace&apos;s owner or an administrator can change its branding.</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Preview of what signers see</span>
        <div style={preview} className="flex items-center gap-3 rounded-md px-4 py-3" data-testid="brand-preview">
          {/* eslint-disable-next-line @next/next/no-img-element -- the workspace's own small logo */}
          {initial.logoUrl ? <img src={initial.logoUrl} alt={`${workspaceName} logo`} className="h-10 w-auto max-w-[10rem] object-contain" /> : null}
          <span className="text-base font-medium">{workspaceName}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="brand-color" className="text-sm font-medium text-ink">
            Brand colour
          </label>
          <div className="flex items-center gap-2">
            <input aria-label="Pick the brand colour" type="color" value={valid ?? '#2F5D50'} onChange={(e) => setColor(e.target.value.toUpperCase())} className="size-11 rounded-sm border border-control-border bg-surface" />
            <input id="brand-color" value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} className={`${INPUT} w-32 font-mono`} aria-describedby="brand-contrast" />
          </div>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">Text on the colour</legend>
          <div className="flex gap-4">
            {(['light', 'dark'] as const).map((t) => (
              <label key={t} className="flex min-h-11 items-center gap-2 text-base text-ink">
                <input type="radio" name="brand-text" checked={text === t} onChange={() => setText(t)} className="size-5 accent-ink" />
                {t === 'light' ? 'Light' : 'Dark'}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <p id="brand-contrast" className="text-sm text-ink-body" aria-live="polite">
        {problem ?? `Readable: contrast ${ratio?.toFixed(2)}:1 (at least 4.5:1 is needed).`}
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="brand-footer" className="text-sm font-medium text-ink">
          Email footer (optional, plain text, up to {MAX_FOOTER} characters)
        </label>
        <textarea id="brand-footer" value={footer} maxLength={MAX_FOOTER} rows={3} onChange={(e) => setFooter(e.target.value)} className={`${INPUT} py-2`} />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={pending || Boolean(problem)} onClick={() => run(() => saveBrandingAction({ orgId, color, text, footer }))}>
          {pending ? 'Saving…' : 'Save branding'}
        </Button>
        {initial.saved ? (
          <Button type="button" variant="outline" disabled={pending} onClick={() => run(() => clearBrandingAction(orgId))}>
            Switch branding off
          </Button>
        ) : null}
      </div>
      {initial.saved ? (
        <div className="flex flex-col gap-2 border-t border-hairline pt-4">
          <label htmlFor="brand-logo" className="text-sm font-medium text-ink">
            Logo (PNG or JPEG, up to 200 KB)
          </label>
          <input id="brand-logo" ref={fileRef} type="file" accept="image/png,image/jpeg" className="text-base text-ink" />
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                const f = fileRef.current?.files?.[0];
                if (!f) return setMessage({ ok: false, text: 'Choose a logo file first.' });
                const fd = new FormData();
                fd.set('orgId', orgId);
                fd.set('logo', f);
                run(() => uploadLogoAction(fd));
              }}
            >
              Upload the logo
            </Button>
            {initial.logoUrl ? (
              <Button type="button" variant="outline" disabled={pending} onClick={() => run(() => removeLogoAction(orgId))}>
                Remove the logo
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Save a brand colour first; then you can add a logo.</p>
      )}
      {message ? <Notice tone={message.ok ? 'success' : 'danger'}>{message.text}</Notice> : null}
    </div>
  );
}
