'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';

/** Re-checks every few seconds; the page swaps to the download view when sealing has finished. */
export function Finalising() {
  const t = useT();
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <p role="status" className="mt-6 text-sm text-ink-muted">
      {t('final.preparing')}
    </p>
  );
}
