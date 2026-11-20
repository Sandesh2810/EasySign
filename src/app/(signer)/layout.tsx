import type { Metadata } from 'next';
import { PRODUCT_NAME } from '@/config/brand';
import { ReportAbuseFooter } from './report-abuse';

// The signing surface is deliberately plain: white, high contrast, nothing decorative.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function SignerLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-ink">
      <header className="border-b border-hairline px-4 py-3 sm:px-6">
        <p className="text-base font-medium text-ink">
          {PRODUCT_NAME} <span className="font-normal text-ink-muted">· secure signing</span>
        </p>
      </header>
      <main id="main" className="flex-1">{children}</main>
      <ReportAbuseFooter />
    </div>
  );
}
