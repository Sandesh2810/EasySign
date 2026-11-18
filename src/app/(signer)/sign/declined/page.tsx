import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Document declined' };

// Shown right after someone declines. It needs no session: the link was switched off by the decline.
export default function DeclinedPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-medium text-ink">You declined this document</h1>
      <p className="mt-3 text-base text-ink-body">
        It has been stopped for everyone and the sender has been told, together with your reason if you gave one. Nothing was signed on your behalf. You can close this page.
      </p>
      <p className="mt-3 text-base text-ink-body">If you declined by mistake, ask the sender to send the document again.</p>
    </div>
  );
}
