'use client';

// Compares a file on the visitor's device with the sealed document's SHA-256. The file is read and hashed
// in the browser (Web Crypto) and is never uploaded anywhere.
import { useId, useState } from 'react';
import { sameSha256 } from '@/lib/verify-result';

const MAX_BYTES = 100 * 1024 * 1024;

type State =
  | { kind: 'idle' }
  | { kind: 'working'; name: string }
  | { kind: 'match'; name: string }
  | { kind: 'mismatch'; name: string; sha: string }
  | { kind: 'error'; message: string };

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function FileCheck({ expected }: { expected: string }) {
  const id = useId();
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function check(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setState({ kind: 'error', message: 'That file is larger than any document this service seals (100 MB), so it cannot be the sealed copy.' });
      return;
    }
    if (!globalThis.crypto?.subtle) {
      setState({ kind: 'error', message: 'This browser cannot check files on this page. Try another browser, or compare the SHA-256 below yourself.' });
      return;
    }
    setState({ kind: 'working', name: file.name });
    try {
      const sha = toHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
      setState(sameSha256(sha, expected) ? { kind: 'match', name: file.name } : { kind: 'mismatch', name: file.name, sha });
    } catch {
      setState({ kind: 'error', message: 'This file could not be read. Choose it again, or try another browser.' });
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-hairline p-4 sm:p-5">
      <label htmlFor={id} className="block text-lg font-medium text-ink">
        Check your copy
      </label>
      <p id={`${id}-hint`} className="mt-1 text-base text-ink-body">
        Choose the signed PDF you were given. It is checked on this device and is not uploaded.
      </p>
      <input
        id={id}
        type="file"
        accept="application/pdf,.pdf"
        aria-describedby={`${id}-hint`}
        onChange={(e) => void check(e.target.files?.[0])}
        className="mt-3 block w-full max-w-md text-base text-ink file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-pill file:border file:border-control-border file:bg-surface file:px-5 file:text-base file:font-medium file:text-ink hover:file:bg-surface-sand"
      />
      <div aria-live="polite" className="mt-4">
        {state.kind === 'working' && <p className="text-base text-ink-body">Checking {state.name}…</p>}
        {state.kind === 'match' && (
          <div className="rounded-md border-2 border-[#1d6b3a] p-4" data-result="authentic">
            <p className="text-lg font-medium text-ink">Authentic</p>
            <p className="mt-1 text-base text-ink-body">
              <span className="break-all">{state.name}</span> is exactly the document that was sealed for this code. Not one byte has changed.
            </p>
          </div>
        )}
        {state.kind === 'mismatch' && (
          <div className="rounded-md border-2 border-[#9b1c1c] p-4" data-result="mismatch">
            <p className="text-lg font-medium text-ink">Does not match</p>
            <p className="mt-1 text-base text-ink-body">
              <span className="break-all">{state.name}</span> is not the document that was sealed for this code. It may have been changed, or it may be a different file
              (for example the separate certificate, or the original before signing).
            </p>
            <p className="mt-2 text-sm text-ink-muted">
              SHA-256 of your file: <span className="break-all font-mono">{state.sha}</span>
            </p>
          </div>
        )}
        {state.kind === 'error' && <p className="text-base text-ink">{state.message}</p>}
      </div>
    </div>
  );
}
