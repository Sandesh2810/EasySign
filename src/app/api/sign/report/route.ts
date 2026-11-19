// POST /api/sign/report  { reason, token? }
// "Report this document": anyone holding a signing link can flag the document for the platform
// administrators (brief: anti-abuse; AT2.10). It works with a signer session, or with the link's token
// itself when no session exists (not this person's turn yet, document on hold, link switched off),
// because a suspicious document must be reportable without first "opening" it.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { allow, clientIp, TOO_MANY } from '@/lib/rate-limit';
import { friendlyDbError, isSameOrigin, json } from '@/lib/request-guard';
import { hashToken } from '@/lib/signer-token';
import { readSignerClaims, requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';

const body = z.object({ reason: z.string().trim().min(3, 'Say in a few words what is wrong.').max(2000, 'Keep it under 2000 characters.'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() });

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json(403, { error: 'This request did not come from EasySign.' });
  if (!(await allow({ bucket: 'sign_report_ip', limit: 10, windowSeconds: 3600 }, await clientIp()))) return json(429, { error: TOO_MANY });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { error: parsed.error.issues[0]?.message ?? 'That report could not be read. Try again.' });

  const db = supabaseAdmin();
  // Which link is this about? The token from the page wins (it is the document the person is looking at);
  // otherwise the signer session.
  let tokenId: string | null = null;
  if (parsed.data.token) {
    const { data } = await db.from('recipient_tokens').select('id').eq('token_sha256', `\\x${hashToken(parsed.data.token).toString('hex')}`).maybeSingle();
    tokenId = (data?.id as string | undefined) ?? null;
  } else {
    tokenId = (await readSignerClaims())?.tokenId ?? null;
  }
  if (!tokenId) return json(401, { error: 'Open your link again, then report the document from that page.' });

  const { ip, ua } = await requestEvidence();
  const { data, error } = await db.rpc('report_abuse', { p_token_id: tokenId, p_reason: parsed.data.reason, p_ip: ip, p_user_agent: ua });
  if (error) return json(/ES_LINK_INVALID/.test(error.message) ? 401 : 400, { error: friendlyDbError(error.message).message });
  return json(200, { ok: true, already: data === 'already' });
}
