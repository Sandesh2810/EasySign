'use client';
import { useEffect, useRef, useState } from 'react';
import { ReportAbuse } from '../report-abuse';
import { useT } from '@/i18n/client';

type State = { phase: 'working' } | { phase: 'error'; message: string; waiting?: boolean; held?: boolean; token?: string };

export function OpenLink() {
  const t = useT();
  const [state, setState] = useState<State>({ phase: 'working' });
  const started = useRef(false);

  useEffect(() => {
    const exchange = async () => {
      const token = window.location.hash.replace(/^#/, '');
      // Remove the token from the address bar and history straight away.
      window.history.replaceState(null, '', '/s');
      setState({ phase: 'working' });
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        setState({ phase: 'error', message: t('link.incomplete') });
        return;
      }
      try {
        const res = await fetch('/api/sign/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.ok) {
          window.location.replace('/sign');
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        // The link did not open, so there is no session: keep the token in memory so the document can still be reported.
        setState({ phase: 'error', waiting: res.status === 403 && body?.code === 'not_your_turn', held: res.status === 423, token, message: body?.error ?? t('link.cannotOpen') });
      } catch {
        setState({ phase: 'error', message: t('link.offline') });
      }
    };
    // A second link pasted into this same tab only changes the part after "#": handle that too.
    const onHashChange = () => {
      if (window.location.hash.length > 1) void exchange();
    };
    window.addEventListener('hashchange', onHashChange);
    if (!started.current) {
      started.current = true;
      void exchange();
    }
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [t]);

  if (state.phase === 'error') {
    return (
      <div role="alert">
        <h1 className="text-2xl font-medium text-ink">{state.held ? t('link.titleHeld') : state.waiting ? t('link.titleWaiting') : t('link.titleFailed')}</h1>
        <p className="mt-3 text-base text-ink-body">{state.message}</p>
        {state.token ? (
          <div className="mt-8">
            <ReportAbuse token={state.token} startOpen={state.held} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div role="status">
      <h1 className="text-2xl font-medium text-ink">{t('link.opening')}</h1>
      <p className="mt-3 text-base text-ink-body">{t('link.moment')}</p>
      <noscript>
        <p className="mt-3 text-base text-ink">{t('link.noscript')}</p>
      </noscript>
    </div>
  );
}
