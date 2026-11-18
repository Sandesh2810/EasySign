// Server-side rate limiting backed by Postgres (public.rate_limit_hit, service-only).
// Fails closed: if the limiter cannot be reached, the request is refused rather than let through.
import 'server-only';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';

export interface Limit {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export const LIMITS_AUTH = {
  signupPerIp: { bucket: 'signup_ip', limit: 5, windowSeconds: 3600 },
  signupPerEmail: { bucket: 'signup_email', limit: 3, windowSeconds: 3600 },
  signinPerIp: { bucket: 'signin_ip', limit: 30, windowSeconds: 900 },
  signinPerAccount: { bucket: 'signin_account', limit: 10, windowSeconds: 900 },
  confirmPerIp: { bucket: 'confirm_ip', limit: 20, windowSeconds: 900 },
} as const satisfies Record<string, Limit>;

/**
 * The caller's IP address. Behind our own reverse proxy the trustworthy value is the LAST entry of
 * X-Forwarded-For (the one our proxy appended); earlier entries are supplied by the client.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return h.get('x-real-ip') ?? 'local';
}

export async function userAgent(): Promise<string> {
  return ((await headers()).get('user-agent') ?? '').slice(0, 500);
}

/** True when the request is within the limit. */
export async function allow(rule: Limit, key: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('rate_limit_hit', {
    p_bucket: rule.bucket,
    p_key: key,
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });
  if (error) return false;
  return data === true;
}

export const TOO_MANY = 'Too many attempts. Wait a few minutes and try again.';
