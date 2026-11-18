import type { Metadata } from 'next';
import { NO_PHI_NOTICE } from '@/config/brand';
import { SignupForm } from '../auth-forms';

export const metadata: Metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <>
      <SignupForm />
      <p className="mt-6 border-t border-hairline pt-4 text-sm text-ink-muted">{NO_PHI_NOTICE}</p>
    </>
  );
}
