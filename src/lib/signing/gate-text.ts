// Wording for the signer's code screen. Pure, so the page and the actions always say the same thing (in the signer's
// language, D-95).
import type { T } from '@/i18n/format';

/** What to tell someone whose link is locked after too many wrong codes. `until` is an ISO time or "infinity". */
export function lockedMessage(t: T, until: string | null | undefined, now: Date = new Date()): string {
  if (!until || until === 'infinity') return t('gate.lockedForever');
  // nearest minute, at least 1: rounding up made a fresh 15-minute lock read "16 minutes" whenever the database
  // clock was a moment ahead of the web server's (D-89)
  const minutes = Math.max(1, Math.round((new Date(until).getTime() - now.getTime()) / 60_000));
  const span = minutes > 50 ? t('gate.spanHour') : minutes === 1 ? t('gate.spanMinute') : t('gate.spanMinutes', { n: minutes });
  return t('gate.lockedFor', { span });
}

export const triesLeft = (t: T, n: number) => (n === 1 ? t('gate.triesOne') : t('gate.triesMany', { n }));
