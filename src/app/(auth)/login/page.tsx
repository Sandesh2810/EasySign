import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '../auth-forms';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading…</p>}>
      <LoginForm />
    </Suspense>
  );
}
