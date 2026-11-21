// In-person signing (D-86), the host's side: while a host has a session open (their device is in someone else's
// hands), every page and action of their account asks for the PIN first (/in-person).
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export interface OpenInPersonSession {
  session_id: string;
  envelope_id: string;
  title: string;
  signer_name: string;
  pin_hash: string;
  started_at: string;
  /** D-89: the signing itself has ended (declined, expired, …) but the host has not yet come back with the PIN */
  ended: boolean;
}

/**
 * The host's sessions that still lock their account: open ones, and ended ones not yet cleared with the PIN or by
 * signing out (D-89). If the lookup fails it throws, so the account never opens by mistake.
 */
export async function openInPersonSessions(userId: string): Promise<OpenInPersonSession[]> {
  const { data, error } = await supabaseAdmin().rpc('in_person_host_open', { p_actor: userId });
  if (error) throw new Error('Could not check for in-person signing in progress.');
  return (data ?? []) as OpenInPersonSession[];
}

export const IN_PERSON_HOST_PAGE = '/in-person';
