// Public verification page (Phase 3, AT3.2). The QR code and footer on every sealed page point here
// (/verify?code=ES-...). Shows only what public.verify_lookup allows: status, completion time, number of
// signers and the hashes; never names, emails or the title. No sign-in, no cookies, no third-party scripts.
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PRODUCT_NAME } from '@/config/brand';
import { lookupCode, VerifyUnavailableError } from '@/lib/verify';
import type { VerifyResult } from '@/lib/verify-result';
import { FileCheck } from './file-check';

export const metadata: Metadata = {
  title: 'Check a document',
  robots: { index: false, follow: false },
};

const fmtUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const STATUS_TEXT: Record<Exclude<Extract<VerifyResult, { kind: 'found' }>['status'], 'completed'>, { title: string; body: string }> = {
  in_progress: { title: 'Still being signed', body: 'This document has been sent but not everyone has finished yet. There is no sealed copy to check until it is complete.' },
  declined: { title: 'Declined', body: 'Someone declined to sign this document, so it was never completed. No sealed copy exists.' },
  voided: { title: 'Cancelled', body: 'The sender cancelled this document before it was completed. No sealed copy exists.' },
  expired: { title: 'Expired', body: 'The signing links expired before everyone finished, so this document was never completed. No sealed copy exists.' },
};

function NotFound() {
  return (
    <section aria-labelledby="result-title" className="mt-8">
      <h2 id="result-title" className="text-xl font-medium text-ink">No document found for this code</h2>
      <p className="mt-2 text-base text-ink-body">
        Check that you typed the code exactly as printed at the bottom of each page of the signed document, for example
        {' '}<span className="font-mono">ES-2611-XXXX-XXXX-XXXX-XX</span>. Letters and digits only matter; dashes and spaces do not.
      </p>
    </section>
  );
}

async function Result({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = (await searchParams).code;
  const code = typeof q === 'string' ? q : '';
  let result: VerifyResult;
  try {
    result = await lookupCode(code);
  } catch (e) {
    if (!(e instanceof VerifyUnavailableError)) throw e;
    return <p className="mt-8 text-base text-ink">The check could not be done right now. Please try again in a few minutes.</p>;
  }
  if (result.kind === 'empty') return null;
  if (result.kind === 'limited') {
    return (
      <p className="mt-8 text-base text-ink" role="alert">
        Too many checks from your network. Wait 10 minutes and try again.
      </p>
    );
  }
  if (result.kind === 'not_found') return <NotFound />;

  if (result.status !== 'completed') {
    const t = STATUS_TEXT[result.status];
    return (
      <section aria-labelledby="result-title" className="mt-8">
        <p className="text-sm text-ink-muted">Verification code <span className="font-mono">{result.code}</span></p>
        <h2 id="result-title" className="mt-1 text-xl font-medium text-ink">{t.title}</h2>
        <p className="mt-2 text-base text-ink-body">{t.body}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="result-title" className="mt-8">
      <p className="text-sm text-ink-muted">Verification code <span className="font-mono">{result.code}</span></p>
      <h2 id="result-title" className="mt-1 text-xl font-medium text-ink">Completed and sealed by {PRODUCT_NAME}</h2>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-base sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-muted">Completed</dt>
        <dd className="text-ink">{result.completedAt ? fmtUtc(result.completedAt) : 'Not recorded'}</dd>
        <dt className="text-ink-muted">Signed by</dt>
        <dd className="text-ink">{result.signerCount === 1 ? '1 person' : `${result.signerCount ?? 0} people`}</dd>
      </dl>
      {result.finalSha256 ? (
        <FileCheck expected={result.finalSha256} />
      ) : (
        <p className="mt-6 text-base text-ink">The sealed file&apos;s fingerprint is not available for this document.</p>
      )}
      <details className="mt-6 text-base">
        <summary className="min-h-11 cursor-pointer py-2.5 text-ink">Technical details</summary>
        <dl className="mt-2 space-y-3 text-sm">
          <div>
            <dt className="text-ink-muted">SHA-256 of the sealed PDF</dt>
            <dd className="break-all font-mono text-ink">{result.finalSha256 ?? 'Not recorded'}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Pre-seal SHA-256 (what the digital seal covers)</dt>
            <dd className="break-all font-mono text-ink">{result.presealSha256 ?? 'Not recorded'}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Seal certificate key id</dt>
            <dd className="break-all font-mono text-ink">{result.sealKeyId ?? 'Not recorded (see the certificate in the document)'}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-ink-body">
          The sealed PDF carries a digital seal. A PDF reader such as Adobe Acrobat Reader reports whether the file was changed after sealing.
          The seal certificate is self-signed, so the reader may say the signer&apos;s identity is unknown or not trusted; compare the key id above
          with the one in the document&apos;s certificate, or check the file on this page.
        </p>
      </details>
    </section>
  );
}

export default function VerifyPage({ searchParams }: PageProps<'/verify'>) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-ink">
      <header className="border-b border-hairline px-4 py-3 sm:px-6">
        <p className="text-base font-medium text-ink">
          {PRODUCT_NAME} <span className="font-normal text-ink-muted">· document check</span>
        </p>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-medium text-ink">Check a signed document</h1>
        <p className="mt-2 text-base text-ink-body">
          Enter the verification code printed at the bottom of every page. You will see whether the document was completed, and you can check
          that your copy has not been changed. No names or email addresses are shown here.
        </p>
        <form method="get" action="/verify" className="mt-6 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor="code" className="block text-base font-medium text-ink">Verification code</label>
            <input
              id="code"
              name="code"
              type="text"
              required
              maxLength={64}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ES-2611-XXXX-XXXX-XXXX-XX"
              className="mt-1 min-h-12 w-full rounded-md border border-control-border bg-surface px-4 font-mono text-lg text-ink placeholder:text-[#5a5a5a] focus:outline-2 focus:outline-offset-2 focus:outline-focus"
            />
          </div>
          <button type="submit" className="inline-flex min-h-12 items-center justify-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink hover:opacity-90">
            Check
          </button>
        </form>
        <Suspense fallback={<p className="mt-8 text-base text-ink-muted">Checking…</p>}>
          <Result searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  );
}
