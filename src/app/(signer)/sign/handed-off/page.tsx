import type { Metadata } from 'next';
import { signerI18n } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await signerI18n();
  return { title: t('handed.meta') };
}

// Shown right after someone hands their part to another person (D-83). It needs no session: their link was switched
// off by the hand-off.
export default async function HandedOffPage() {
  const { t } = await signerI18n();
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-medium text-ink">{t('handed.title')}</h1>
      <p className="mt-3 text-base text-ink-body">{t('handed.body')}</p>
      <p className="mt-3 text-base text-ink-body">{t('handed.mistake')}</p>
    </div>
  );
}
