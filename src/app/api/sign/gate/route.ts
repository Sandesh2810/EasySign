// POST /api/sign/gate  { action, code? }
// The extra identity check a sender can ask for before a signing link opens anything (D-59, AT2.7):
//   action "access_code"  + code : check the access code the sender handed over personally
//   action "request_code"        : ask for a six-digit code by email
//   action "email_code"   + code : check that six-digit code
// Wrong tries are counted in the database (five, then the link locks). Passing the check reissues this
// browser's signer session as "verified". The session stays bound to one link and one document: it
// cannot be carried to another document, because the link id is inside the signed cookie.
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyAccessCode } from '@/lib/access-code';
import { env } from '@/lib/env';
import { allow, clientIp, TOO_MANY } from '@/lib/rate-limit';
import { isSameOrigin, json } from '@/lib/request-guard';
import { hashOtp, signSession } from '@/lib/signer-token';
import { lockedMessage, triesLeft } from '@/lib/signing/gate-text';
import { loadSignerContext, requestEvidence, signerCookieName, signerCookieOptions, SIGNER_SESSION_TTL_SECONDS, type SignerContext } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';

const EXPIRED = 'Your session has ended. Open your link again.';
const body = z.object({ action: z.enum(['access_code', 'request_code', 'email_code']), code: z.string().max(200).optional() });

/** The check is passed: the session cookie is reissued as "verified" for this same link. */
function passed(ctx: SignerContext) {
  const cookie = signSession(
    { tokenId: ctx.tokenId, recipientId: ctx.recipient.id, envelopeId: ctx.envelope.id, level: 'verified' },
    env.sessionCookieKey(),
    { ttlSeconds: SIGNER_SESSION_TTL_SECONDS },
  );
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  res.cookies.set(signerCookieName(), cookie, signerCookieOptions());
  return res;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json(403, { error: 'This request did not come from EasySign.' });
  if (!(await allow({ bucket: 'sign_gate_ip', limit: 40, windowSeconds: 900 }, await clientIp()))) return json(429, { error: TOO_MANY });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { error: 'That request was not understood. Reload the page and try again.' });

  const ctx = await loadSignerContext({ allowUnverified: true });
  if (!ctx) return json(401, { error: EXPIRED });
  // Nothing to check: either the sender asked for no check, or this session has already passed it.
  if (ctx.gate === null) return json(200, { ok: true, already: true });

  const db = supabaseAdmin();
  const { ip, ua } = await requestEvidence();
  const { action } = parsed.data;

  if (action === 'access_code') {
    if (ctx.gate !== 'access_code') return json(400, { error: 'This link does not use an access code. Reload the page.' });
    const code = parsed.data.code ?? '';
    if (code.trim().length === 0) return json(400, { error: 'Type the access code you were given.' });
    // Step 1 counts this try before the answer is known, so guesses sent at the same moment share one allowance.
    const begin = await db.rpc('signer_auth_begin', { p_token_id: ctx.tokenId });
    const b = Array.isArray(begin.data) ? begin.data[0] : null;
    if (begin.error || !b) return json(401, { error: EXPIRED });
    if (b.status === 'locked') return json(423, { error: lockedMessage(b.locked_until as string | null) });
    const matched = await verifyAccessCode(code, b.access_code_hash as string | null);
    const finish = await db.rpc('signer_auth_finish', { p_token_id: ctx.tokenId, p_ok: matched, p_ip: ip, p_user_agent: ua });
    const f = Array.isArray(finish.data) ? finish.data[0] : null;
    if (finish.error || !f) return json(500, { error: 'The code could not be checked. Please try again.' });
    if (f.status === 'ok') return passed(ctx);
    if (f.status === 'locked') return json(423, { error: lockedMessage(f.locked_until as string | null) });
    return json(403, { error: `That code is not right. Check capital letters and spaces. ${triesLeft(f.attempts_left as number)}` });
  }

  if (ctx.gate !== 'email_otp') return json(400, { error: 'This link does not use an emailed code. Reload the page.' });

  if (action === 'request_code') {
    const { data, error } = await db.rpc('signer_request_otp', { p_token_id: ctx.tokenId, p_ip: ip, p_user_agent: ua });
    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row) return json(401, { error: EXPIRED });
    switch (row.status) {
      case 'queued':
        return json(200, { ok: true, message: 'A code is on its way to your email. It usually arrives within a minute and works for 10 minutes.' });
      case 'wait':
        return json(429, { error: 'A code was just requested. Wait a minute before asking for another one, and check your spam folder.' });
      case 'limit':
        return json(429, { error: 'Too many codes were requested in the last hour. Try again in an hour.' });
      case 'locked':
        return json(423, { error: lockedMessage(row.retry_at as string | null) });
      default:
        return json(500, { error: 'A code could not be sent. Please try again.' });
    }
  }

  const code = (parsed.data.code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) return json(400, { error: 'Type the 6 digits from the email.' });
  // Only a keyed hash of what was typed goes to the database, which holds only a keyed hash of the real code.
  const hash = hashOtp(code, ctx.recipient.id, env.signerTokenKey());
  const { data, error } = await db.rpc('signer_verify_otp', { p_token_id: ctx.tokenId, p_otp_hash: `\\x${hash.toString('hex')}`, p_ip: ip, p_user_agent: ua });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return json(500, { error: 'The code could not be checked. Please try again.' });
  if (row.status === 'ok') return passed(ctx);
  if (row.status === 'locked') return json(423, { error: lockedMessage(row.locked_until as string | null) });
  if (row.status === 'expired') return json(410, { error: 'That code is no longer valid (codes work once, for 10 minutes). Ask for a new one below.' });
  return json(403, { error: `That code is not right. ${triesLeft(row.attempts_left as number)}` });
}
