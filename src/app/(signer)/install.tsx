'use client';
// D-96: registers the signer app's service worker (public/sw.js), which only provides the offline page. Nothing is
// shown; failures are ignored (signing works the same without it).
import { useEffect } from 'react';

export function RegisterSignerApp() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
