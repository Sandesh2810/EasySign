'use client';
import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Notice, TextField } from '@/components/ui';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { confirmEmailAction, signInAction, signUpAction, type FormState } from './actions';

// A provider button is shown only once that provider has really been set up for this deployment
// (NEXT_PUBLIC_AUTH_GOOGLE=1 / NEXT_PUBLIC_AUTH_MICROSOFT=1 in the env file). A button that cannot work is not shown.
const PROVIDERS = {
  google: process.env.NEXT_PUBLIC_AUTH_GOOGLE === '1',
  azure: process.env.NEXT_PUBLIC_AUTH_MICROSOFT === '1',
};

function OAuthButtons({ next }: { next: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (provider: 'google' | 'azure') => {
    setBusy(provider);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider,
      // Least privilege: identity only. EasySign never asks for mailbox access.
      options: { redirectTo, scopes: provider === 'azure' ? 'openid email profile' : undefined },
    });
    if (e) {
      setError('That sign-in option is not available right now. Use email and password instead.');
      setBusy(null);
    }
  };
  if (!PROVIDERS.google && !PROVIDERS.azure) return null;
  return (
    <>
      <div className="flex flex-col gap-3">
        {PROVIDERS.google ? (
          <Button type="button" variant="outline" onClick={() => start('google')} disabled={busy !== null}>
            {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
          </Button>
        ) : null}
        {PROVIDERS.azure ? (
          <Button type="button" variant="outline" onClick={() => start('azure')} disabled={busy !== null}>
            {busy === 'azure' ? 'Opening Microsoft…' : 'Continue with Microsoft'}
          </Button>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <Divider />
    </>
  );
}

const Divider = () => (
  <div className="my-6 flex items-center gap-3 text-sm text-ink-muted" role="separator">
    <span className="h-px flex-1 bg-hairline" />
    or use email
    <span className="h-px flex-1 bg-hairline" />
  </div>
);

export function LoginForm() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/app';
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction, null);
  return (
    <>
      <h1 className="mb-6 text-2xl font-medium text-ink">Sign in</h1>
      {params.get('error') === 'oauth' ? (
        <div className="mb-4">
          <Notice tone="danger">Sign-in did not complete. Try again, or use email and password.</Notice>
        </div>
      ) : null}
      <OAuthButtons next={next} />
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" required />
        <TextField id="password" name="password" type="password" label="Password" autoComplete="current-password" required />
        {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-ink-body">
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </>
  );
}

export function SignupForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, null);
  if (state?.ok) {
    return (
      <>
        <h1 className="mb-4 text-2xl font-medium text-ink">{state.devConfirmUrl ? 'One more step' : 'Check your email'}</h1>
        <Notice tone="success">{state.message}</Notice>
        {state.devConfirmUrl ? (
          <p className="mt-6">
            <a
              href={state.devConfirmUrl}
              className="inline-flex min-h-11 items-center justify-center rounded-pill bg-ink px-6 text-base font-medium text-on-ink no-underline hover:opacity-90"
            >
              Confirm my email now
            </a>
          </p>
        ) : null}
        <p className="mt-6 text-sm text-ink-body">
          Already confirmed? <Link href="/login">Sign in</Link>
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-6 text-2xl font-medium text-ink">Create your account</h1>
      <OAuthButtons next="/app" />
      <form action={action} className="flex flex-col gap-4">
        <TextField id="name" name="name" label="Your name" autoComplete="name" required maxLength={100} />
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" required />
        <TextField id="password" name="password" type="password" label="Password" autoComplete="new-password" required minLength={10} hint="At least 10 characters." />
        {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-ink-body">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </>
  );
}

export function ConfirmEmailForm() {
  const params = useSearchParams();
  const [state, action, pending] = useActionState<FormState, FormData>(confirmEmailAction, null);
  const tokenHash = params.get('token_hash') ?? '';
  const type = params.get('type') ?? 'signup';
  return (
    <>
      <h1 className="mb-4 text-2xl font-medium text-ink">Confirm your email</h1>
      <p className="mb-6 text-base text-ink-body">Press the button to confirm this email address and finish creating your account.</p>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        {state && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
        <Button type="submit" disabled={pending || !tokenHash}>
          {pending ? 'Confirming…' : 'Confirm email'}
        </Button>
      </form>
      {state && !state.ok ? (
        <p className="mt-6 text-sm text-ink-body">
          If you confirmed earlier, just <Link href="/login">sign in</Link>. Otherwise <Link href="/signup">sign up again</Link> to get a fresh link.
        </p>
      ) : null}
      {!tokenHash ? (
        <div className="mt-4">
          <Notice tone="danger">This link is incomplete. Open the link from your email again.</Notice>
        </div>
      ) : null}
    </>
  );
}
