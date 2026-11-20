import Link from 'next/link';
import { PRODUCT_NAME } from '@/config/brand';

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-sand">
      <header className="px-6 py-5">
        <Link href="/" className="text-lg font-medium text-ink no-underline">
          {PRODUCT_NAME}
        </Link>
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-md rounded-lg bg-surface p-8 shadow-soft">{children}</div>
      </main>
    </div>
  );
}
