// The consent wording on file (Phase 3, AT3.3). Before a consent is recorded the app puts its current wording
// on file; the database computes the fingerprint from the words and refuses a version name reused for other
// words. Done once per server process; a failure is retried on the next consent.
import 'server-only';
import { createHash } from 'node:crypto';
import { CONSENT_TEXT, CONSENT_VERSION } from '@/config/legal';
import { supabaseAdmin } from '@/lib/supabase/admin';

let onFile: Promise<string> | null = null;

export function consentOnFile(): Promise<string> {
  onFile ??= (async () => {
    const local = createHash('sha256').update(CONSENT_TEXT, 'utf8').digest('hex');
    const { data, error } = await supabaseAdmin().rpc('register_consent_version', { p_version: CONSENT_VERSION, p_body: CONSENT_TEXT });
    if (error) throw new Error(`the consent wording could not be put on file: ${error.message}`);
    if (data !== local) throw new Error('the consent wording on file does not match this version of the app');
    return local;
  })().catch((e) => {
    onFile = null;
    throw e;
  });
  return onFile;
}
