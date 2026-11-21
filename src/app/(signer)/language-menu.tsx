'use client';
// D-95: the language menu on every signer page. Each language is named in itself.
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALE_NAMES, LOCALES } from '@/i18n/config';
import { useLocale, useT } from '@/i18n/client';
import { setSignerLanguageAction } from './language-action';

export function LanguageMenu() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const chosen = String(new FormData(e.currentTarget).get('lang') ?? '');
        start(async () => {
          await setSignerLanguageAction(chosen);
          router.refresh();
        });
      }}
    >
      <label htmlFor="signer-language" className="text-sm text-ink-muted">
        {t('common.language')}
      </label>
      <select id="signer-language" name="lang" defaultValue={locale} className="min-h-11 rounded-sm border border-control-border bg-surface px-2 text-sm text-ink">
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="inline-flex min-h-11 items-center rounded-pill border border-control-border bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sand disabled:opacity-60">
        {t('common.change')}
      </button>
    </form>
  );
}
