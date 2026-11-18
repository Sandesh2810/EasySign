'use client';
import { useEffect, useRef, useState } from 'react';

type State = { phase: 'working' } | { phase: 'error'; message: string };

export function OpenLink() {
  const [state, setState] = useState<State>({ phase: 'working' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.replace(/^#/, '');
    // Remove the token from the address bar and history straight away.
    window.history.replaceState(null, '', '/s');
    (async () => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        setState({ phase: 'error', message: 'This signing link is incomplete. Open the link from your email again, or ask the sender for a new one.' });
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
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState({ phase: 'error', message: body?.error ?? 'This signing link could not be opened. Try again in a moment.' });
      } catch {
        setState({ phase: 'error', message: 'We could not reach the server. Check your connection and open the link again.' });
      }
    })();
  }, []);

  if (state.phase === 'error') {
    return (
      <div role="alert">
        <h1 className="text-2xl font-medium text-ink">This link did not open</h1>
        <p className="mt-3 text-base text-ink-body">{state.message}</p>
      </div>
    );
  }
  return (
    <div role="status">
      <h1 className="text-2xl font-medium text-ink">Opening your document…</h1>
      <p className="mt-3 text-base text-ink-body">This takes a moment.</p>
      <noscript>
        <p className="mt-3 text-base text-ink">Signing needs JavaScript. Turn it on in your browser and open the link again.</p>
      </noscript>
    </div>
  );
}
