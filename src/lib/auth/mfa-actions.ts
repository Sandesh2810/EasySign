'use server';
// Two-step sign-in (Phase 3 slice 4, AT3.4, D-69). The authenticator codes are checked by Supabase Auth through the
// person's own session (so their session cookie is upgraded to "aal2" on success); every outcome is written to
// the audit trail by a server-only database function; recovery codes are made here and only their fingerprints kept.
import { isIP } from 'node:net';
import { redirect } from 'next/navigation';
import { PRODUCT_NAME } from '@/config/brand';
import { allow, clientIp, TOO_MANY, userAgent } from '@/lib/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getUser, mfaStatus, requireAdminMfa, requireUser } from './session';
import { generateRecoveryCodes, hashRecoveryCode, isAuthenticatorCode, mfaGate, normaliseRecoveryCode, safeNext } from './mfa-policy';

export type MfaResult = { ok: true; codes?: string[]; message?: string } | { ok: false; message: string };
export type EnrollStart = { ok: true; factorId: string; qr: string; secret: string } | { ok: false; message: string };

const FAIL = 'Something went wrong. Nothing was changed. Try again.';
const WRONG = 'That code is not right. Check the six-digit code in your authenticator app and try again.';

async function evidence() {
  const ip = await clientIp();
  return { ip: isIP(ip) ? ip : null, ua: (await userAgent()).slice(0, 500) };
}

async function record(userId: string, event: 'mfa_enrolled' | 'mfa_verified' | 'mfa_failed' | 'mfa_removed') {
  const { ip, ua } = await evidence();
  await supabaseAdmin().rpc('mfa_record_event', { p_actor: userId, p_event: event, p_ip: ip, p_user_agent: ua });
}

async function issueCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const hashes = codes.map((c) => hashRecoveryCode(normaliseRecoveryCode(c)!));
  const { error } = await supabaseAdmin().rpc('mfa_store_recovery_codes', { p_actor: userId, p_hashes: hashes });
  if (error) throw new Error('recovery codes could not be stored');
  return codes;
}

/** Step 1 of set-up: a new authenticator secret, shown as a QR code and as text. */
export async function startEnrollAction(): Promise<EnrollStart> {
  const user = await requireUser('/app/account/security');
  if (!(await allow({ bucket: 'mfa_enroll', limit: 10, windowSeconds: 3600 }, user.id))) return { ok: false, message: TOO_MANY };
  if ((await mfaStatus(user.id)).enrolled) return { ok: false, message: 'Two-step sign-in is already on for your account.' };
  const supabase = await createSupabaseServerClient();
  // an unfinished earlier attempt would block a new one
  const listed = await supabase.auth.mfa.listFactors();
  for (const f of listed.data?.all ?? []) {
    if (f.factor_type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: PRODUCT_NAME, friendlyName: `${PRODUCT_NAME} ${new Date().toISOString().slice(0, 10)}` });
  if (error || !data) return { ok: false, message: FAIL };
  return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

/** Step 2 of set-up: the first code proves the app works; then ten recovery codes are shown once. */
export async function confirmEnrollAction(factorId: string, code: string): Promise<MfaResult> {
  const user = await requireUser('/app/account/security');
  if (!(await allow({ bucket: 'mfa_verify', limit: 10, windowSeconds: 600 }, user.id))) return { ok: false, message: TOO_MANY };
  if (!isAuthenticatorCode(code) || typeof factorId !== 'string' || factorId.length > 64) return { ok: false, message: WRONG };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
  if (error) {
    await record(user.id, 'mfa_failed');
    return { ok: false, message: WRONG };
  }
  await record(user.id, 'mfa_enrolled');
  try {
    return { ok: true, codes: await issueCodes(user.id) };
  } catch {
    return { ok: true, message: 'Two-step sign-in is on, but your recovery codes could not be made. Use "Make new recovery codes" now.' };
  }
}

/** Replaces all recovery codes. Needs a code from this session (and, for the admin, a recent one). */
export async function newRecoveryCodesAction(): Promise<MfaResult> {
  const user = await requireUser('/app/account/security');
  const status = await mfaStatus(user.id);
  if (!status.enrolled || user.aal !== 'aal2') return { ok: false, message: 'Enter a code from your authenticator app first.' };
  if (mfaGate({ aal: user.aal, amr: user.amr, hasFactor: true, admin: status.admin, nowSeconds: Date.now() / 1000 }) !== 'ok') {
    redirect('/mfa?next=%2Fapp%2Faccount%2Fsecurity&fresh=1');
  }
  try {
    return { ok: true, codes: await issueCodes(user.id) };
  } catch {
    return { ok: false, message: FAIL };
  }
}

/** Switches two-step sign-in off. Not allowed for the platform admin, for whom it is required. */
export async function removeMfaAction(): Promise<MfaResult> {
  const user = await requireUser('/app/account/security');
  const status = await mfaStatus(user.id);
  if (status.admin) return { ok: false, message: 'As the administrator you must keep two-step sign-in on.' };
  if (!status.enrolled) return { ok: true };
  if (user.aal !== 'aal2') return { ok: false, message: 'Enter a code from your authenticator app first.' };
  const supabase = await createSupabaseServerClient();
  const listed = await supabase.auth.mfa.listFactors();
  for (const f of listed.data?.all ?? []) {
    if (f.factor_type === 'totp') {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (error) return { ok: false, message: FAIL };
    }
  }
  await record(user.id, 'mfa_removed');
  await supabase.auth.refreshSession();
  return { ok: true, message: 'Two-step sign-in is off.' };
}

/** The code page after a password sign-in (and for the admin's fresh check). */
export async function verifyMfaAction(_prev: MfaResult | null, formData: FormData): Promise<MfaResult> {
  const user = await getUser();
  if (!user) redirect('/login');
  if (!(await allow({ bucket: 'mfa_verify', limit: 10, windowSeconds: 600 }, user.id))) return { ok: false, message: TOO_MANY };
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  if (!isAuthenticatorCode(code)) return { ok: false, message: WRONG };
  const supabase = await createSupabaseServerClient();
  const listed = await supabase.auth.mfa.listFactors();
  const factor = listed.data?.totp?.[0];
  if (!factor) redirect('/app/account/security');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) {
    await record(user.id, 'mfa_failed');
    return { ok: false, message: WRONG };
  }
  await record(user.id, 'mfa_verified');
  redirect(safeNext(formData.get('next')));
}

/** A lost authenticator: one recovery code switches two-step sign-in off so it can be set up again. */
export async function recoverWithCodeAction(_prev: MfaResult | null, formData: FormData): Promise<MfaResult> {
  const user = await getUser();
  if (!user) redirect('/login');
  const code = normaliseRecoveryCode(String(formData.get('recovery') ?? ''));
  if (!code) return { ok: false, message: 'A recovery code has ten letters and digits, like ABCDE-FGH23.' };
  const { ip, ua } = await evidence();
  const { data, error } = await supabaseAdmin().rpc('mfa_use_recovery_code', { p_actor: user.id, p_code_sha256: hashRecoveryCode(code), p_ip: ip, p_user_agent: ua });
  if (error) return { ok: false, message: FAIL };
  if (data === 'limited') return { ok: false, message: TOO_MANY };
  if (data !== 'ok') return { ok: false, message: 'That recovery code is not right, or it has been used already.' };
  await (await createSupabaseServerClient()).auth.refreshSession();
  redirect('/app/account/security?recovered=1');
}

/** The admin removes someone else's authenticator after checking who they are. */
export async function adminResetMfaAction(_prev: MfaResult | null, formData: FormData): Promise<MfaResult> {
  const user = await requireAdminMfa('/app/admin');
  const target = String(formData.get('user_id') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(target)) return { ok: false, message: FAIL };
  if (formData.get('confirm') !== 'on') return { ok: false, message: 'Tick the box to confirm you have checked who is asking.' };
  const { ip, ua } = await evidence();
  const { data, error } = await supabaseAdmin().rpc('admin_reset_mfa', { p_actor: user.id, p_user: target, p_ip: ip, p_user_agent: ua });
  if (error) return { ok: false, message: error.message.startsWith('ES_SELF') ? 'Use one of your own recovery codes instead.' : FAIL };
  return { ok: true, message: Number(data) > 0 ? 'Done. Their authenticator was removed; they can sign in with their password and set it up again.' : 'They had no authenticator set up.' };
}
