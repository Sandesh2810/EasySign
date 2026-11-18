import type { Metadata } from 'next';
import Link from 'next/link';
import { NO_PHI_NOTICE } from '@/config/brand';
import { UploadForm } from './upload-form';

export const metadata: Metadata = { title: 'New document' };

export default function NewDocumentPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href="/app">Dashboard</Link> / New document
        </p>
        <h1 className="mt-2 font-serif text-4xl font-light italic text-ink">Upload a document</h1>
        <p className="mt-2 text-base text-ink-body">Your original file is stored unchanged. Signatures are added to a separate, sealed copy when everyone has signed.</p>
      </div>
      <UploadForm />
      <section className="rounded-lg bg-surface p-6 text-sm text-ink-body shadow-soft">
        <h2 className="mb-2 text-base font-medium text-ink">Before you upload</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>{NO_PHI_NOTICE}</li>
          <li>
            Some documents cannot be signed electronically, or need a notary or witnesses: for example wills and testamentary trusts, some family-law documents, court orders, and certain default,
            foreclosure, eviction and cancellation notices. If you are unsure, ask a lawyer before sending.
          </li>
          <li>Password-protected PDFs, PDFs that are already digitally signed and fillable PDF forms are not accepted. Print them to a new PDF first.</li>
        </ul>
      </section>
    </div>
  );
}
