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
import { decide } from '@/lib/email-budget';
import { loadBudget } from '@/lib/email-budget-state';
import { safeNext } from '@/lib/safe-redirect';
import { allow, clientIp, LIMITS_AUTH, TOO_MANY } from '@/lib/rate-limit';
import { getMailProvider } from '@/mail';
import { verifyEmailTemplate } from '@/mail/templates';
import { NOTIFY_MODE } from '@/config/brand';

export type FormState = { ok: boolean; message: string; devConfirmUrl?: string } | null;

/**
 * True only when the app runs on this computer with emails written to a folder instead of being sent.
 * In that one situation the confirmation link is offered on screen after sign-up, because there is no
 * mailbox to receive it. Both conditions are required, so a deployed site can never show the link.
 */
const isLocalDevelopment = () => NOTIFY_MODE === 'log' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.appUrl());

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
const SIGNUP_DONE_LOCAL = 'Your account is created. Nothing was emailed, because this copy of EasySign runs only on this computer. Press the button below to confirm your email address and finish.';

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse({ name: formData.get('name'), email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  const { name, email: address, password } = parsed.data;

  const ip = await clientIp();
  if (!(await allow(LIMITS_AUTH.signupPerIp, ip)) || !(await allow(LIMITS_AUTH.signupPerEmail, address))) return { ok: false, message: TOO_MANY };

  // Sign-up emails count against the same daily email budget as everything else (they have their own
  // reserved share, and may spill into the rest). If the whole day is used up, say so before creating an
  // account that could not be confirmed.
  const budget = await loadBudget(null).catch(() => null);
  if (!budget) return { ok: false, message: 'Something went wrong on our side. Please try again in a minute.' };
  if (decide('P0_AUTH', budget.state).action === 'defer') {
    return { ok: false, message: 'We cannot send confirmation emails right now because today’s email limit has been reached. Please try again tomorrow.' };
  }

  const { data, error } = await supabaseAdmin().auth.admin.generateLink({
    type: 'signup',
    email: address,
    password,
    options: { data: { full_name: name } },
  });
  if (error || !data?.properties?.hashed_token) {
    // On this computer there is nobody to hide the reason from, and a silent "check your email" would be a dead end.
    if (isLocalDevelopment()) {
      return /already|registered|exists/i.test(error?.message ?? '')
        ? { ok: false, message: 'An account with this email address already exists here. Sign in instead, or use a different email address.' }
        : { ok: false, message: 'The account could not be created. Check the email address and try again.' };
    }
    // Same answer whether the address is new, already registered, or not allowed: no account enumeration.
    return { ok: true, message: SIGNUP_DONE };
  }

  const confirmUrl = `${env.appUrl()}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=signup`;
  const mail = verifyEmailTemplate({ name, confirmUrl });
  await getMailProvider().send({ to: address, kind: 'auth_verify', ...mail, idempotencyKey: `auth_verify:${data.user.id}:${data.properties.hashed_token.slice(0, 16)}` });
  // counted after the provider accepted it, so the meter matches what was really handed over
  const counted = await supabaseAdmin().rpc('email_budget_record', { p_class: 'P0_AUTH', p_user: null, p_restricted: false });
  if (counted.error) console.error('email budget: a sign-up email was sent but could not be counted');
  return isLocalDevelopment() ? { ok: true, message: SIGNUP_DONE_LOCAL, devConfirmUrl: confirmUrl } : { ok: true, message: SIGNUP_DONE };
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
