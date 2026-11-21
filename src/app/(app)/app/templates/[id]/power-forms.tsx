'use client';
// D-87: public forms of a one-person template. Anyone with a form's link can fill it in and sign their own copy.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { createPowerFormAction, setPowerFormStatusAction } from '../power-form-actions';

export interface PowerFormRow {
  id: string;
  title: string;
  slug: string;
  status: 'active' | 'paused';
  daily_limit: number;
  email_check: boolean;
  can_manage: boolean;
  sent_today: number;
  sent_total: number;
}

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';

export function PowerForms({ templateId, templateName, appUrl, forms }: { templateId: string; templateName: string; appUrl: string; forms: PowerFormRow[] }) {
  const router = useRouter();
  const [title, setTitle] = useState(templateName);
  const [limit, setLimit] = useState('50');
  const [emailCheck, setEmailCheck] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const res = await createPowerFormAction({ templateId, title, dailyLimit: Number(limit), emailCheck }).catch(() => ({ ok: false as const, message: 'Could not reach the server. Nothing was saved.' }));
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  const toggle = (f: PowerFormRow) =>
    start(async () => {
      const res = await setPowerFormStatusAction({ templateId, formId: f.id, active: f.status !== 'active' }).catch(() => ({ ok: false as const, message: 'Could not reach the server. Nothing was changed.' }));
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  const copy = async (f: PowerFormRow) => {
    await navigator.clipboard.writeText(`${appUrl}/f/${f.slug}`).catch(() => undefined);
    setCopied(f.id);
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pf-title" className="text-sm font-medium text-ink">
            Title people see
          </label>
          <input id="pf-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pf-limit" className="text-sm font-medium text-ink">
            Most submissions a day (1 to 500)
          </label>
          <input id="pf-limit" type="number" inputMode="numeric" min={1} max={500} value={limit} onChange={(e) => setLimit(e.target.value)} className={`${INPUT} w-32`} />
        </div>
        <label className="flex items-start gap-3 text-base text-ink">
          <input type="checkbox" checked={emailCheck} onChange={(e) => setEmailCheck(e.target.checked)} className="mt-1 size-5 shrink-0 accent-ink" />
          <span>Check their email address first (a code is emailed to them; it uses the daily email allowance)</span>
        </label>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Create a public form'}
          </Button>
        </div>
      </form>
      {message ? <Notice tone={message.ok ? 'success' : 'danger'}>{message.text}</Notice> : null}
      {forms.length ? (
        <ul className="divide-y divide-hairline">
          {forms.map((f) => (
            <li key={f.id} className="flex flex-col gap-2 py-3">
              <p className="text-base text-ink [overflow-wrap:anywhere]">
                {f.title} <span className="text-sm text-ink-muted">· {f.status === 'active' ? 'taking submissions' : 'paused'}</span>
              </p>
              <p className="text-sm text-ink-muted">
                {f.sent_today} today (limit {f.daily_limit}) · {f.sent_total} in all{f.email_check ? ' · email checked first' : ''}
              </p>
              <p className="break-all font-mono text-sm text-ink">{`${appUrl}/f/${f.slug}`}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void copy(f)}>
                  {copied === f.id ? 'Link copied' : 'Copy the link'}
                </Button>
                {f.can_manage ? (
                  <Button type="button" variant="outline" disabled={pending} onClick={() => toggle(f)}>
                    {f.status === 'active' ? 'Pause' : 'Resume'}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
