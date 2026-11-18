'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-checks every few seconds; the page swaps to the download view when sealing has finished. */
export function Finalising() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <p role="status" className="mt-6 text-sm text-ink-muted">
      Preparing the final document… you can also close this page and come back later with the same link.
    </p>
  );
}
