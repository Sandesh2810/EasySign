'use server';
// Sign-up, sign-in, email confirmation and sign-out.
// Sign-up never lets Supabase send the email: the server asks the Auth admin API to generate the
// confirmation link and delivers it through EasySign's own mailer (DECISIONS D-31), so the email
// goes to the dev outbox in log mode and through the email budget later.
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { safeNext } from '@/lib/safe-redirect';
import { allow, clientIp, LIMITS_AUTH, TOO_MANY } from '@/lib/rate-limit';
import { getMailProvider } from '@/mail';
import { verifyEmailTemplate } from '@/mail/templates';
import { NOTIFY_MODE } from '@/config/brand';

export type FormState = { ok: boolean; message: string } | null;

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(100),
  email,
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
});
const signInSchema = z.object({ email, password: z.string().min(1).max(200) });

const SIGNUP_DONE =
  'If this address can be registered, a confirmation link is on its way. Open it to finish creating your account.' +
  (NOTIFY_MODE === 'log' ? ' (Development mode: the email was written to the app\\.dev-outbox folder instead of being sent.)' : '');

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse({ name: formData.get('name'), email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  const { name, email: address, password } = parsed.data;

  const ip = await clientIp();
  if (!(await allow(LIMITS_AUTH.signupPerIp, ip)) || !(await allow(LIMITS_AUTH.signupPerEmail, address))) return { ok: false, message: TOO_MANY };

  const { data, error } = await supabaseAdmin().auth.admin.generateLink({
    type: 'signup',
    email: address,
    password,
    options: { data: { full_name: name } },
  });
  // Same answer whether the address is new, already registered, or not allowed: no account enumeration.
  if (error || !data?.properties?.hashed_token) return { ok: true, message: SIGNUP_DONE };

  const confirmUrl = `${env.appUrl()}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=signup`;
  const mail = verifyEmailTemplate({ name, confirmUrl });
  await getMailProvider().send({ to: address, kind: 'auth_verify', ...mail, idempotencyKey: `auth_verify:${data.user.id}:${data.properties.hashed_token.slice(0, 16)}` });
  return { ok: true, message: SIGNUP_DONE };
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse({ email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return { ok: false, message: 'Enter your email and password.' };
  const ip = await clientIp();
  if (!(await allow(LIMITS_AUTH.signinPerIp, ip)) || !(await allow(LIMITS_AUTH.signinPerAccount, `${parsed.data.email}|${ip}`))) return { ok: false, message: TOO_MANY };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { ok: false, message: 'That email and password do not match, or the email has not been confirmed yet.' };
  redirect(safeNext(formData.get('next') as string | null));
}

const confirmSchema = z.object({ token_hash: z.string().min(10).max(200), type: z.enum(['signup', 'email', 'recovery', 'magiclink', 'invite']) });

/** Runs when the person presses the button on /auth/confirm (a POST), so link scanners cannot use up the link. */
export async function confirmEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = confirmSchema.safeParse({ token_hash: formData.get('token_hash'), type: formData.get('type') });
  if (!parsed.success) return { ok: false, message: 'This confirmation link is not valid. Request a new one by signing up again.' };
  if (!(await allow(LIMITS_AUTH.confirmPerIp, await clientIp()))) return { ok: false, message: TOO_MANY };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp(parsed.data);
  if (error) return { ok: false, message: 'This confirmation link has expired or was already used. Sign in, or sign up again to get a new one.' };
  redirect('/app');
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
