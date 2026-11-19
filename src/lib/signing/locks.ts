// Which people on a document have a link that is locked after too many wrong codes (D-59).
// Server only: the table behind it is closed to signed-in users, so the caller must already have
// established that the user may see this document (the document page reads it through the user's
// own session first).
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type LinkLock = 'timed' | 'until-unlocked';

export async function loadLinkLocks(envelopeId: string): Promise<Map<string, LinkLock>> {
  const locked = new Map<string, LinkLock>();
  const { data } = await supabaseAdmin().from('recipient_auth').select('recipient_id, locked_until').eq('envelope_id', envelopeId).not('locked_until', 'is', null);
  const now = Date.now();
  for (const l of data ?? []) {
    const until = l.locked_until as string;
    if (until === 'infinity') locked.set(l.recipient_id as string, 'until-unlocked');
    else if (new Date(until).getTime() > now) locked.set(l.recipient_id as string, 'timed');
  }
  return locked;
}
