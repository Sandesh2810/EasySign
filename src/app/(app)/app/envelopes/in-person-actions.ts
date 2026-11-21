'use server';
// D-86: the host starts in-person signing for a person whose turn it is. This device becomes that person's signing
// screen; the host's own account asks for the PIN until the session ends.
import { cookies } from 'next/headers';
import { z } from 'zod';
import { env } from '@/lib/env';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/db-error';
import { hashPin, pinProblem } from '@/lib/in-person';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { mintTokenRecord } from '@/lib/signing/links';
import { requestEvidence, signerCookieName, signerCookieOptions, SIGNER_SESSION_TTL_SECONDS } from '@/lib/signing/session';
import { signSession } from '@/lib/signer-token';
import { supabaseAdmin } from '@/lib/supabase/admin';

const input = z.object({ envelopeId: z.uuid(), recipientId: z.uuid(), pin: z.string().max(20), confirm: z.string().max(20) });

export async function startInPersonAction(raw: { envelopeId: string; recipientId: string; pin: string; confirm: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'Something was missing. Reload the page and try again.' };
  const { envelopeId, recipientId, pin, confirm } = parsed.data;
  const user = await requireUser(`/app/envelopes/${envelopeId}`);
  const problem = pinProblem(pin, confirm);
  if (problem) return { ok: false, message: problem };
  if (!(await allow({ bucket: 'in_person_start', limit: 20, windowSeconds: 3600 }, user.id))) return { ok: false, message: TOO_MANY };

  const admin = supabaseAdmin();
  const token = mintTokenRecord(recipientId);
  const started = await admin.rpc('start_in_person', {
    p_actor: user.id,
    p_envelope_id: envelopeId,
    p_recipient_id: recipientId,
    p_token_id: token.token_id,
    p_nonce: token.nonce,
    p_token_sha256: token.token_sha256,
    p_pin_hash: hashPin(pin),
  });
  if (started.error) return { ok: false, message: friendlyDbError(started.error.message).message };

  // open the signer's session on this device the same way a link does (marks it opened, records the evidence)
  const { ip, ua } = await requestEvidence();
  const opened = await admin.rpc('signer_open', { p_token_sha256: token.token_sha256, p_ip: ip, p_user_agent: ua });
  const row = Array.isArray(opened.data) ? opened.data[0] : null;
  if (opened.error || !row || row.turn !== 'now') {
    await admin.rpc('in_person_host_end', { p_actor: user.id, p_session_id: started.data as string, p_ok: true });
    return { ok: false, message: 'The signing screen could not be opened. Nothing was changed; try again.' };
  }
  const cookie = signSession({ tokenId: token.token_id, recipientId, envelopeId, level: 'link' }, env.sessionCookieKey(), { ttlSeconds: SIGNER_SESSION_TTL_SECONDS });
  (await cookies()).set(signerCookieName(), cookie, signerCookieOptions());
  // the browser then loads the signing screen as a whole new page (not an in-app move): nothing of the host's
  // account stays in the page's memory, and no dialog of the document page can linger over the signing screen
  return { ok: true };
}
