'use client';
// D-90: API keys for a workspace. A new key is shown once.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/components/ui';
import { createApiKeyAction, revokeApiKeyAction } from './api-key-actions';

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_name: string;
}

const SCOPES: { id: string; label: string }[] = [
  { id: 'documents:read', label: 'Read documents and download completed ones' },
  { id: 'documents:write', label: 'Create documents from templates' },
  { id: 'documents:send', label: 'Send documents' },
];
const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const day = (s: string | null) => (s ? s.slice(0, 10) : 'never');

export function ApiKeys({ orgId, keys }: { orgId: string; keys: ApiKeyRow[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['documents:read']);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const res = await createApiKeyAction({ orgId, name, scopes }).catch(() => ({ ok: false as const, message: 'Could not reach the server. Nothing was saved.' }));
      if (!res.ok) return setMessage({ ok: false, text: res.message });
      setFresh(res.key);
      setCopied(false);
      setName('');
      setMessage(null);
      router.refresh();
    });
  const revoke = (id: string) =>
    start(async () => {
      const res = await revokeApiKeyAction(id).catch(() => ({ ok: false, message: 'Could not reach the server. Nothing was changed.' }));
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });

  return (
    <div className="flex flex-col gap-4">
      {fresh ? (
        <div className="flex flex-col gap-2 rounded-md border border-control-border p-4" role="status">
          <p className="text-base font-medium text-ink">Your new API key. Copy it now: it will not be shown again.</p>
          <code className="break-all rounded-sm bg-surface-sand px-2 py-1 font-mono text-sm text-ink" data-testid="new-api-key">
            {fresh}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(fresh).then(() => setCopied(true)).catch(() => undefined)}>
              {copied ? 'Copied' : 'Copy the key'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setFresh(null)}>
              I have stored it
            </Button>
          </div>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-name" className="text-sm font-medium text-ink">
            Name (for example the system that will use it)
          </label>
          <input id="api-key-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-ink">What it may do</legend>
          {SCOPES.map((s) => (
            <label key={s.id} className="flex min-h-11 items-center gap-3 text-base text-ink">
              <input
                type="checkbox"
                name="api-scope"
                value={s.id}
                checked={scopes.includes(s.id)}
                onChange={(e) => setScopes(e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))}
                className="size-5 accent-ink"
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create an API key'}
          </Button>
        </div>
      </form>
      {message ? <Notice tone={message.ok ? 'success' : 'danger'}>{message.text}</Notice> : null}
      {keys.length ? (
        <ul className="divide-y divide-hairline">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-base text-ink [overflow-wrap:anywhere]">
                  {k.name} <span className="font-mono text-sm text-ink-muted">{k.prefix}…</span>
                </p>
                <p className="text-sm text-ink-muted">
                  {k.scopes.join(', ')} · made by {k.created_by_name} on {day(k.created_at)} · last used {day(k.last_used_at)}
                  {k.revoked_at ? ` · revoked ${day(k.revoked_at)}` : ''}
                </p>
              </div>
              {k.revoked_at ? null : (
                <Button type="button" variant="outline" disabled={pending} onClick={() => revoke(k.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
