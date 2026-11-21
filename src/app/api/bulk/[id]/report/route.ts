// GET /api/bulk/{id}/report -> the bulk send report as CSV (Phase 4 slice 9, AT4.2, D-85): every row of the file with its
// status and reason. Only for the batch's maker or an owner/administrator (bulk_batch_view checks). Cells that look like
// spreadsheet formulas are neutralised (CSV injection), and the file is always a download.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { toCsv } from '@/lib/csv';
import { json, requireApiUser } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';

const STATUS: Record<string, string> = { pending: 'waiting', sent: 'sent', failed: 'not sent', invalid: 'not sent (problem in the file)', cancelled: 'cancelled' };

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return json(404, { error: 'Batch not found.' });
  const { data, error } = await supabaseAdmin().rpc('bulk_batch_view', { p_actor: auth.user.id, p_batch_id: id.data });
  if (error || !data) return json(404, { error: 'Batch not found.' });
  const b = data as { title: string; items: { row_no: number; name: string; email: string; status: string; reason: string | null; envelope_id: string | null }[] };
  const csv = toCsv([['row', 'name', 'email', 'status', 'reason', 'document'], ...b.items.map((i) => [String(i.row_no), i.name, i.email, STATUS[i.status] ?? i.status, i.reason ?? '', i.envelope_id ?? ''])]);
  return new Response('﻿' + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bulk-send-report.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
