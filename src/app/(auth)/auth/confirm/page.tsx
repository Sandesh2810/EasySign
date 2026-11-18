import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConfirmEmailForm } from '../../auth-forms';

export const metadata: Metadata = { title: 'Confirm email', robots: { index: false } };

// The link in the email lands here. Confirmation happens only when the person presses the button
// (a POST), so automatic link scanners in mail systems cannot use the link up.
export default function ConfirmPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
      <ConfirmEmailForm />
    </Suspense>
  );
}
