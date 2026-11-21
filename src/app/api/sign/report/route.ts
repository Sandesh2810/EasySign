// POST /api/sign/report  { reason, token? }
// "Report this document": anyone holding a signing link can flag the document for the platform
// administrators (brief: anti-abuse; AT2.10). It works with a signer session, or with the link's token
// itself when no session exists (not this person's turn yet, document on hold, link switched off),
// because a suspicious document must be reportable without first "opening" it.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { PRODUCT_NAME } from '@/config/brand';
import { signerI18n } from '@/i18n/server';
import { signerDbError } from '@/i18n/db-messages';
import type { MessageKey } from '@/i18n/format';
import { allow, clientIp } from '@/lib/rate-limit';
import { isSameOrigin, json } from '@/lib/request-guard';
import { hashToken } from '@/lib/signer-token';
import { readSignerClaims, requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';

const body = z.object({ reason: z.string().trim().min(3, 'abuse.reasonShort').max(2000, 'abuse.reasonLong'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() });

export async function POST(request: NextRequest) {
  const { t } = await signerI18n();
  if (!isSameOrigin(request)) return json(403, { error: t('common.notFromUs', { product: PRODUCT_NAME }) });
  if (!(await allow({ bucket: 'sign_report_ip', limit: 10, windowSeconds: 3600 }, await clientIp()))) return json(429, { error: t('common.tooMany') });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { error: t(((parsed.error.issues[0]?.message ?? '').startsWith('abuse.') ? parsed.error.issues[0]!.message : 'abuse.unreadable') as MessageKey) });

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
  if (!tokenId) return json(401, { error: t('abuse.openAgain') });

  const { ip, ua } = await requestEvidence();
  const { data, error } = await db.rpc('report_abuse', { p_token_id: tokenId, p_reason: parsed.data.reason, p_ip: ip, p_user_agent: ua });
  if (error) return json(/ES_LINK_INVALID/.test(error.message) ? 401 : 400, { error: signerDbError(t, error.message).message });
  return json(200, { ok: true, already: data === 'already' });
}
