// Server side of the public /verify page: one rate-limited, audited database lookup (public.verify_lookup).
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { clientIp } from '@/lib/rate-limit';
import { codeForLookup, parseVerifyResponse, type VerifyResult } from './verify-result';

export class VerifyUnavailableError extends Error {}

export async function lookupCode(input: string | null | undefined): Promise<VerifyResult> {
  const code = codeForLookup(input);
  if (!code) return { kind: 'empty' };
  const caller = await clientIp(); // hashed by the database before it is stored; never logged
  const { data, error } = await supabaseAdmin().rpc('verify_lookup', { p_code: code, p_caller: caller });
  if (error) throw new VerifyUnavailableError('The check could not be done right now.');
  return parseVerifyResponse(data);
}
