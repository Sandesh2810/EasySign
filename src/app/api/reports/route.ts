// GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD -> the report for the workspace in use, as CSV (Phase 5 slice 4, AT5.4,
// D-93). The database decides what the person may count (members: their own documents). Formula-looking names are
// neutralised (CSV injection) and the file is always a download.
import type { NextRequest } from 'next/server';
import { json, requireApiUser } from '@/lib/request-guard';
import { parsePeriod, reportCsv, reportFilename, type Report } from '@/lib/reports';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { activeWorkspace } from '@/lib/workspace';

export async function GET(request: NextRequest) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const q = request.nextUrl.searchParams;
  const period = parsePeriod(q.get('from') ?? undefined, q.get('to') ?? undefined);
  if (!period.ok) return json(400, { error: period.message });
  const { current } = await activeWorkspace(auth.user.id);
  const { data, error } = await supabaseAdmin().rpc('report_summary', { p_actor: auth.user.id, p_org: current.orgId, p_from: period.from, p_to: period.to });
  if (error || !data) return json(404, { error: 'Report not available.' });
  const report = data as Report;
  return new Response('﻿' + reportCsv(report), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${reportFilename(report)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
