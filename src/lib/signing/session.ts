// The signer's session (DECISIONS D-23). A signer has no account: after the link is exchanged the browser
// holds a short-lived signed cookie bound to that link's id. Every request re-checks the link in the
// database, so revoking or expiring a link ends the session at once.
import 'server-only';
import { isIP } from 'node:net';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { env } from '@/lib/env';
import { clientIp, userAgent } from '@/lib/rate-limit';
import { verifySession, type SessionClaims } from '@/lib/signer-token';
import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * On https the cookie carries the "__Host-" prefix: browsers then accept it only from this exact
 * host, over https, with no Domain attribute. That matters on a shared free suffix (D-48), where a
 * stranger's site under the same suffix could otherwise plant a cookie with our name.
 */
export const signerCookieName = () => (env.appUrl().startsWith('https://') ? '__Host-es_signer' : 'es_signer');
export const SIGNER_SESSION_TTL_SECONDS = 2 * 3600;

export const signerCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.appUrl().startsWith('https://'),
  path: '/',
  maxAge: SIGNER_SESSION_TTL_SECONDS,
});

export async function readSignerClaims(): Promise<SessionClaims | null> {
  await connection(); // always per-request: never prerendered or cached
  const raw = (await cookies()).get(signerCookieName())?.value;
  if (!raw) return null;
  const check = verifySession(raw, env.sessionCookieKey());
  return check.ok ? check.claims : null;
}

export interface SignerContext {
  tokenId: string;
  expiresAt: string;
  recipient: { id: string; name: string; email: string; role: string; status: string; is_sender: boolean; completed_at: string | null };
  envelope: {
    id: string;
    org_id: string;
    title: string;
    status: string;
    public_code: string;
    sender_id: string;
    final_sha256: string | null;
    sealed_storage_backend: string | null;
    sealed_storage_path: string | null;
    certificate_storage_path: string | null;
  };
}

/** The signer behind this request, or null when there is no live link. Never trusts the cookie alone. */
export async function loadSignerContext(): Promise<SignerContext | null> {
  const claims = await readSignerClaims();
  if (!claims) return null;
  const admin = supabaseAdmin();
  const { data: tok } = await admin.from('recipient_tokens').select('id, recipient_id, envelope_id, expires_at, revoked_at').eq('id', claims.tokenId).maybeSingle();
  if (!tok || tok.revoked_at || new Date(tok.expires_at as string).getTime() <= Date.now()) return null;
  if (tok.recipient_id !== claims.recipientId || tok.envelope_id !== claims.envelopeId) return null;
  const [{ data: recipient }, { data: envelope }] = await Promise.all([
    admin.from('recipients').select('id, name, email, role, status, is_sender, completed_at').eq('id', tok.recipient_id).maybeSingle(),
    admin
      .from('envelopes')
      .select('id, org_id, title, status, public_code, sender_id, final_sha256, sealed_storage_backend, sealed_storage_path, certificate_storage_path')
      .eq('id', tok.envelope_id)
      .maybeSingle(),
  ]);
  if (!recipient || !envelope) return null;
  return { tokenId: tok.id as string, expiresAt: tok.expires_at as string, recipient: recipient as SignerContext['recipient'], envelope: envelope as SignerContext['envelope'] };
}

/** IP (null when it is not a real address, e.g. local development) and browser string for the audit trail. */
export async function requestEvidence(): Promise<{ ip: string | null; ua: string }> {
  const ip = await clientIp();
  return { ip: isIP(ip) ? ip : null, ua: await userAgent() };
}
