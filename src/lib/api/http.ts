// D-90: the API's request handling: key check, scopes, rate limits, idempotency, JSON answers. Server-only.
import 'server-only';
import { NextResponse } from 'next/server';
import { allow, clientIp } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { bearerKey, keySha256, requestSha256, retryAfterSeconds, type ApiScope } from './keys';

export interface ApiContext {
  keyId: string;
  orgId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  scopes: ApiScope[];
}

export const API_RATE = { limit: 60, windowSeconds: 60 } as const;
const BAD_KEY_RATE = { bucket: 'api_bad_key_ip', limit: 30, windowSeconds: 600 } as const;

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function apiJson(status: number, body: unknown, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...HEADERS, ...extra } });
}
export function apiError(status: number, code: string, message: string, extra: Record<string, string> = {}): NextResponse {
  return apiJson(status, { error: { code, message } }, extra);
}

/** Who is calling and whether they may do this. Returns the context, or the response to send back. */
export async function authenticate(request: Request, scope: ApiScope): Promise<{ ctx: ApiContext } | { response: NextResponse }> {
  const key = bearerKey(request.headers.get('authorization'));
  const ip = await clientIp();
  const refuse = async (status: number, code: string, message: string) => {
    // wrong or missing keys are limited per address (keys cannot be guessed, but nobody gets to keep trying)
    if (!(await allow(BAD_KEY_RATE, ip))) return { response: apiError(429, 'rate_limited', 'Too many requests with a wrong key.', { 'Retry-After': String(retryAfterSeconds(BAD_KEY_RATE.windowSeconds)) }) };
    return { response: apiError(status, code, message) };
  };
  if (!key) return refuse(401, 'unauthorized', 'Send your API key as "Authorization: Bearer ynms_…".');
  const { data } = await supabaseAdmin().rpc('api_key_resolve', { p_key_sha256: keySha256(key) });
  const row = (Array.isArray(data) ? data[0] : null) as { key_id: string; org_id: string; user_id: string; scopes: ApiScope[]; role: ApiContext['role'] } | null;
  if (!row) return refuse(401, 'unauthorized', 'This API key is not valid, was revoked, or its owner no longer has access.');
  if (!row.scopes.includes(scope)) return { response: apiError(403, 'forbidden', `This key may not do this: it needs the "${scope}" permission.`) };
  // a viewer may only read, whatever the key says
  if (row.role === 'viewer' && scope !== 'documents:read') return { response: apiError(403, 'forbidden', 'The person who made this key can only read documents.') };
  if (!(await allow({ bucket: 'api_key', ...API_RATE }, row.key_id))) {
    return { response: apiError(429, 'rate_limited', `Too many requests: at most ${API_RATE.limit} a minute per key.`, { 'Retry-After': String(retryAfterSeconds(API_RATE.windowSeconds)) }) };
  }
  return { ctx: { keyId: row.key_id, orgId: row.org_id, userId: row.user_id, role: row.role, scopes: row.scopes } };
}

/**
 * Runs a write once per Idempotency-Key (optional header, 1–200 characters). A repeat of the same request gets the
 * stored answer with "Idempotent-Replayed: true"; the same key with a different request gets 422; one still running 409.
 * Server errors (5xx) are not stored, so the request can be tried again.
 */
export async function idempotent(ctx: ApiContext, request: Request, path: string, body: string, run: () => Promise<NextResponse>): Promise<NextResponse> {
  const idem = request.headers.get('idempotency-key');
  if (idem === null) return run();
  if (idem.length < 1 || idem.length > 200 || /[\u0000-\u001f\u007f]/.test(idem)) return apiError(400, 'bad_request', 'The Idempotency-Key header must be 1 to 200 printable characters.');
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('api_idem_begin', { p_key_id: ctx.keyId, p_idem: idem, p_request_sha256: requestSha256(request.method, path, body) });
  if (error) return apiError(500, 'server_error', 'Something went wrong. Try again.');
  const s = data as { state: 'new' | 'done' | 'in_progress' | 'mismatch'; status?: number; body?: unknown };
  if (s.state === 'done') return apiJson(s.status ?? 200, s.body, { 'Idempotent-Replayed': 'true' });
  if (s.state === 'in_progress') return apiError(409, 'in_progress', 'A request with this Idempotency-Key is still being handled. Try again shortly.');
  if (s.state === 'mismatch') return apiError(422, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request.');
  const res = await run();
  if (res.status < 500) {
    const stored = await res.clone().json().catch(() => null);
    await admin.rpc('api_idem_finish', { p_key_id: ctx.keyId, p_idem: idem, p_status: res.status, p_body: stored });
  }
  return res;
}
