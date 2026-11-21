// Receives Content-Security-Policy violation reports from browsers (Phase 3 slice 5, AT3.5, D-70).
// Anyone can post here (browsers send reports without cookies), so it is rate limited per network, accepts at
// most 16 KB and 10 reports per request, and keeps only what parseCspReports extracts.
import type { NextRequest } from 'next/server';
import { parseCspReports } from '@/lib/csp';
import { allow, clientIp } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_BYTES = 16 * 1024;
const empty = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

/** The body as text, or null as soon as it passes `max` bytes (the rest is never read). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: NextRequest) {
  if (!(await allow({ bucket: 'csp_report_ip', limit: 60, windowSeconds: 600 }, await clientIp()))) return empty(429);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) return empty(413);
  // D-89 F13: read at most MAX_BYTES even when no length is announced (chunked), instead of the whole body first
  const text = await readCapped(request, MAX_BYTES);
  if (text === null) return empty(413);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const reports = parseCspReports(json);
  if (reports.length > 0) await supabaseAdmin().rpc('record_csp_reports', { p_reports: reports });
  return empty(204);
}
