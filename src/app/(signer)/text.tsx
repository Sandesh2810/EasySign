'use client';
// D-95: one message in the signer's language, for places a server component cannot wait for the language (loading
// placeholders).
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/format';

export function Text({ k }: { k: MessageKey }) {
  return <>{useT()(k)}</>;
}
