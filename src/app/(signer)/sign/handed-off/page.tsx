import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Handed over' };

// Shown right after someone hands their part to another person (D-83). It needs no session: their link was switched
// off by the hand-off.
export default function HandedOffPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-medium text-ink">You handed this document to someone else</h1>
      <p className="mt-3 text-base text-ink-body">
        Your link no longer works, and nothing was signed on your behalf. The person you named has their own link: they get it by email if the sender sends by email, otherwise from the sender. The sender has been told who and why. You can close this page.
      </p>
      <p className="mt-3 text-base text-ink-body">If you did this by mistake, ask the sender to give the document back to you.</p>
    </div>
  );
}
