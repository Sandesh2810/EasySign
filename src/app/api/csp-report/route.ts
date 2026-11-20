// Receives Content-Security-Policy violation reports from browsers (Phase 3 slice 5, AT3.5, D-70).
// Anyone can post here (browsers send reports without cookies), so it is rate limited per network, accepts at
// most 16 KB and 10 reports per request, and keeps only what parseCspReports extracts.
import type { NextRequest } from 'next/server';
import { parseCspReports } from '@/lib/csp';
import { allow, clientIp } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_BYTES = 16 * 1024;
const empty = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  if (!(await allow({ bucket: 'csp_report_ip', limit: 60, windowSeconds: 600 }, await clientIp()))) return empty(429);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) return empty(413);
  const text = await request.text();
  if (text.length > MAX_BYTES) return empty(413);
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
