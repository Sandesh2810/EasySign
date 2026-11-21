// Wording for the signer's code screen. Pure, so the page and the actions always say the same thing.

/** What to tell someone whose link is locked after too many wrong codes. `until` is an ISO time or "infinity". */
export function lockedMessage(until: string | null | undefined, now: Date = new Date()): string {
  if (!until || until === 'infinity') return 'Too many wrong codes. This link is now locked. Ask the person who sent you the document to unlock it.';
  // nearest minute, at least 1: rounding up made a fresh 15-minute lock read "16 minutes" whenever the database
  // clock was a moment ahead of the web server's (D-89)
  const minutes = Math.max(1, Math.round((new Date(until).getTime() - now.getTime()) / 60_000));
  const span = minutes > 50 ? 'about an hour' : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `Too many wrong codes. For your protection this link is locked for ${span}. Nothing else has changed; try again after that.`;
}

export const triesLeft = (n: number) => (n === 1 ? 'You have 1 try left.' : `You have ${n} tries left.`);
