// D-95: the signer's language on the server: their own choice (a cookie set by the language menu), otherwise their
// browser's languages, otherwise English.
import 'server-only';
import { cookies, headers } from 'next/headers';
import { MESSAGES, translator } from './catalog';
import { dirOf, isLocale, LOCALE_COOKIE, negotiate, type Locale } from './config';
import type { T } from './format';

export async function signerLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return negotiate((await headers()).get('accept-language'));
}

export async function signerI18n(): Promise<{ locale: Locale; dir: 'ltr' | 'rtl'; t: T }> {
  const locale = await signerLocale();
  return { locale, dir: dirOf(locale), t: translator(locale) };
}

export const messagesFor = (locale: Locale) => MESSAGES[locale];
