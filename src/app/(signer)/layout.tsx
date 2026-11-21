import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PRODUCT_NAME } from '@/config/brand';
import { I18nProvider } from '@/i18n/client';
import { messagesFor, signerI18n } from '@/i18n/server';
import { LanguageMenu } from './language-menu';
import { ReportAbuseFooter } from './report-abuse';

// The signing surface is deliberately plain: white, high contrast, nothing decorative.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function SignerLayout({ children }: LayoutProps<'/'>) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-surface" />}>
      <SignerShell>{children}</SignerShell>
    </Suspense>
  );
}

// D-95: the signer's language (their choice, else their browser's, else English); Arabic reads right to left
async function SignerShell({ children }: { children: React.ReactNode }) {
  const { locale, dir, t } = await signerI18n();
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale)}>
      <div lang={locale} dir={dir} className="flex min-h-dvh flex-col bg-surface text-ink">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2 sm:px-6">
          <p className="text-base font-medium text-ink">
            <span lang="en" dir="ltr">
              {PRODUCT_NAME}
            </span>{' '}
            <span className="font-normal text-ink-muted">· {t('common.secureSigning')}</span>
          </p>
          <LanguageMenu />
        </header>
        <main id="main" className="flex-1">
          {children}
        </main>
        <ReportAbuseFooter />
      </div>
    </I18nProvider>
  );
}
