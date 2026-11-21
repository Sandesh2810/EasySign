'use client';
// "Questions for the sender" (D-84): this person's private conversation with the sender about the document. Questions
// cannot be edited or removed once sent; they are kept with the document's record.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { useT } from '@/i18n/client';
import { commentAction } from './actions';

export interface ThreadItem {
  id: string;
  mine: boolean;
  body: string;
  at: string;
}

export function QuestionsPanel({ thread, senderName }: { thread: ThreadItem[]; senderName: string }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await commentAction(text).catch(() => ({ ok: false as const, message: t('q.offline') }));
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setText('');
    router.refresh();
  };

  return (
    <details className="rounded-md border border-hairline bg-surface px-4 py-3" open={thread.length > 0}>
      <summary className="cursor-pointer text-base font-medium text-ink">
        {t('q.summary', { sender: senderName })}
        {thread.length ? ` (${thread.length})` : ''}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {thread.length ? (
          <ol className="flex flex-col gap-2" aria-label={t('q.conversation')}>
            {thread.map((c) => (
              <li key={c.id} className={`rounded-md px-3 py-2 text-base ${c.mine ? 'bg-surface-sand' : 'border border-hairline'}`}>
                <p className="text-sm text-ink-muted">
                  {c.mine ? t('q.you') : senderName}, {c.at.slice(0, 16).replace('T', ' ')} UTC
                </p>
                <p className="whitespace-pre-wrap break-words text-ink">{c.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-ink-body">{t('q.intro')}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="question-text" className="text-sm font-medium text-ink">
            {t('q.label')}
          </label>
          <textarea id="question-text" value={text} maxLength={1000} rows={3} onChange={(e) => setText(e.target.value)} className="rounded-sm border border-control-border bg-surface px-3 py-2 text-base text-ink" />
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div>
          <Button type="button" variant="outline" onClick={() => void send()} disabled={busy || !text.trim()}>
            {busy ? t('common.sending') : t('q.send')}
          </Button>
        </div>
      </div>
    </details>
  );
}
