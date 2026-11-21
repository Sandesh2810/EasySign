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

/** The extra identity check this session still has to pass before the link opens anything (D-59). */
export type SignerGate = 'access_code' | 'email_otp';

export interface SignerContext {
  tokenId: string;
  expiresAt: string;
  /** null once the check is passed, or when the sender asked for none. */
  gate: SignerGate | null;
  /** The sender's account is suspended and the document is still open: nothing can be done with it for now. */
  onHold: boolean;
  recipient: { id: string; name: string; email: string; role: string; status: string; is_sender: boolean; completed_at: string | null; locale: string | null };
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
    /** D-83: the sender lets signers hand their part to someone else */
    allow_delegation: boolean;
  };
  /** D-86: set when this session is in-person signing on the host's device */
  inPerson: { sessionId: string; hostName: string; state: 'active' | 'locked' | 'ended' } | null;
}

/**
 * The signer behind this request, or null when there is no live link. Never trusts the cookie alone.
 * A session that has not yet passed the sender's extra check (access code or emailed code) also gets
 * null, so every page, action and download is closed by default. Only the code screen and its own
 * actions pass allowUnverified, and they must look at ctx.gate.
 */
export async function loadSignerContext(opts: { allowUnverified?: boolean; allowLocked?: boolean } = {}): Promise<SignerContext | null> {
  const claims = await readSignerClaims();
  if (!claims) return null;
  const admin = supabaseAdmin();
  const { data: tok } = await admin.from('recipient_tokens').select('id, recipient_id, envelope_id, expires_at, revoked_at').eq('id', claims.tokenId).maybeSingle();
  // D-86: an in-person session whose link was retired (ended) is still described, so the page can say so
  const { data: ip } = await admin.rpc('in_person_touch', { p_token_id: claims.tokenId });
  const ipRow = (Array.isArray(ip) ? ip[0] : null) as { session_id: string; host_name: string; state: 'active' | 'locked' | 'ended' } | null;
  const inPerson = ipRow ? { sessionId: ipRow.session_id, hostName: ipRow.host_name, state: ipRow.state } : null;
  // only the page itself (allowLocked) sees a locked or ended in-person session; every action and download is refused
  if (inPerson && inPerson.state !== 'active' && !opts.allowLocked) return null;
  if (!tok || tok.recipient_id !== claims.recipientId || tok.envelope_id !== claims.envelopeId) return null;
  const linkDead = Boolean(tok.revoked_at) || new Date(tok.expires_at as string).getTime() <= Date.now();
  if (linkDead && !(inPerson && opts.allowLocked)) return null;
  const [{ data: recipient }, { data: envelope }] = await Promise.all([
    admin.from('recipients').select('id, name, email, role, status, is_sender, completed_at, auth_method, locale').eq('id', tok.recipient_id).maybeSingle(),
    admin
      .from('envelopes')
      .select('id, org_id, title, status, public_code, sender_id, final_sha256, sealed_storage_backend, sealed_storage_path, certificate_storage_path, allow_delegation')
      .eq('id', tok.envelope_id)
      .maybeSingle(),
  ]);
  if (!recipient || !envelope) return null;
  // The sender signing their own document is already signed in, so no extra check applies to them.
  const method = recipient.auth_method as string;
  const gate: SignerGate | null = recipient.is_sender || claims.level === 'verified' ? null : method === 'access_code' || method === 'email_otp' ? method : null;
  if (gate && !opts.allowUnverified) return null;
  let onHold = false;
  if (envelope.status === 'sent' || envelope.status === 'in_progress') {
    const [{ data: account }, { data: org }] = await Promise.all([
      admin.from('account_controls').select('trust_level').eq('user_id', envelope.sender_id).maybeSingle(),
      admin.from('org_controls').select('status').eq('org_id', envelope.org_id).maybeSingle(),
    ]);
    onHold = account?.trust_level === 'suspended' || org?.status === 'suspended';
  }
  return { tokenId: tok.id as string, expiresAt: tok.expires_at as string, gate, onHold, recipient: recipient as SignerContext['recipient'], envelope: envelope as SignerContext['envelope'], inPerson };
}

/** IP (null when it is not a real address, e.g. local development) and browser string for the audit trail. */
export async function requestEvidence(): Promise<{ ip: string | null; ua: string }> {
  const ip = await clientIp();
  return { ip: isIP(ip) ? ip : null, ua: await userAgent() };
}
