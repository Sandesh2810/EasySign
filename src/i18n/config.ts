// D-95: the languages of the signing pages and the emails signers receive. Pure: no I/O.
// English is complete and is the source; Spanish, Hindi and Arabic are translations (not yet reviewed by a native
// speaker). Legal texts (consent, intent to sign, approval, excluded documents) stay in English in every language.

export const LOCALES = ['en', 'es', 'hi', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
/** Each language named in itself, as people look for it. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', es: 'Español', hi: 'हिन्दी', ar: 'العربية' };
export const LOCALE_COOKIE = 'ynms_lang';

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
export const dirOf = (l: Locale): 'rtl' | 'ltr' => (l === 'ar' ? 'rtl' : 'ltr');

/** The best supported language for an Accept-Language header ("es-MX,es;q=0.9,en;q=0.8"), or English. */
export function negotiate(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const wanted = header
    .split(',')
    .slice(0, 20)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { lang: tag.trim().toLowerCase().split('-')[0], q: q === undefined ? 1 : Number(q), i };
    })
    .filter((w) => w.lang && Number.isFinite(w.q) && w.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return (wanted.find((w) => isLocale(w.lang))?.lang as Locale | undefined) ?? DEFAULT_LOCALE;
}
