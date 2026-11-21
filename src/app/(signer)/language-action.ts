'use server';
// D-95: the signer chose a language. It is remembered in this browser (a cookie) and, when they have a signing link
// open, with them, so the emails they receive from now on are in that language too.
import { cookies } from 'next/headers';
import { isLocale, LOCALE_COOKIE } from '@/i18n/config';
import { loadSignerContext } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function setSignerLanguageAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: '/', maxAge: 365 * 86_400, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  const ctx = await loadSignerContext({ allowUnverified: true, allowLocked: true }).catch(() => null);
  if (ctx) await supabaseAdmin().rpc('signer_set_locale', { p_token_id: ctx.tokenId, p_locale: locale });
}
