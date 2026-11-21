import type { Metadata } from 'next';
import { signerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await signerI18n();
  return { title: t('declined.meta') };
}

// Shown right after someone declines. It needs no session: the link was switched off by the decline.
export default async function DeclinedPage() {
  const { t } = await signerI18n();
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-medium text-ink">{t('declined.title')}</h1>
      <p className="mt-3 text-base text-ink-body">{t('declined.body')}</p>
      <p className="mt-3 text-base text-ink-body">{t('declined.mistake')}</p>
    </div>
  );
}
