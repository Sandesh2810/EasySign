// POST /api/sign/open  { token }  -> exchanges a signing link for a signer session cookie.
// The token arrives in the request body (it lives in the URL fragment, which browsers never send),
// so it does not appear in any access log. Only its SHA-256 is ever compared with the database.
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { PRODUCT_NAME } from '@/config/brand';
import { signerI18n } from '@/i18n/server';
import { allow, clientIp } from '@/lib/rate-limit';
import { isSameOrigin, json } from '@/lib/request-guard';
import { hashToken, signSession } from '@/lib/signer-token';
import { requestEvidence, signerCookieName, signerCookieOptions, SIGNER_SESSION_TTL_SECONDS } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';

const body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function POST(request: NextRequest) {
  const { t } = await signerI18n();
  const INVALID = t('link.errInvalid');
  if (!isSameOrigin(request)) return json(403, { error: t('common.notFromUs', { product: PRODUCT_NAME }) });
  if (!(await allow({ bucket: 'sign_open_ip', limit: 30, windowSeconds: 900 }, await clientIp()))) return json(429, { error: t('common.tooMany') });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(404, { error: INVALID });

  const { ip, ua } = await requestEvidence();
  const { data, error } = await supabaseAdmin().rpc('signer_open', {
    p_token_sha256: hashToken(parsed.data.token).toString('hex'),
    p_ip: ip,
    p_user_agent: ua,
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return json(404, { error: INVALID });
  // The sender's account is suspended: no session, and a clear warning (AT2.10). The attempt is in the audit trail.
  if (row.turn === 'held') {
    return json(423, { error: t('page.holdBody', { product: PRODUCT_NAME }) });
  }
  // A valid link whose turn has not come: no session is created (the attempt is already in the audit trail).
  if (row.turn === 'waiting') {
    return json(403, { error: t('link.errTurn'), code: 'not_your_turn' });
  }

  const cookie = signSession(
    { tokenId: row.token_id, recipientId: row.recipient_id, envelopeId: row.envelope_id, level: 'link' },
    env.sessionCookieKey(),
    { ttlSeconds: SIGNER_SESSION_TTL_SECONDS },
  );
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  res.cookies.set(signerCookieName(), cookie, signerCookieOptions());
  return res;
}
