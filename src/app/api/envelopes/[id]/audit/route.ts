// GET /api/envelopes/{id}/audit?format=json|pdf -> the document's whole audit trail (archived parts included), with
// the result of re-checking the chain (Phase 3 slice 7, D-72). Members of the workspace only (row-level security
// decides whether the document exists for this person). The export is recorded after it is built.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { loadAuditTrail } from '@/lib/audit-read';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { json, requireApiUser } from '@/lib/request-guard';
import { requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { buildAuditReport } from '@/pdf/audit-report';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return json(404, { error: 'Document not found.' });
  const format = request.nextUrl.searchParams.get('format') === 'pdf' ? 'pdf' : 'json';

  const supabase = await createSupabaseServerClient();
  const { data: env } = await supabase.from('envelopes').select('id, title, status, public_code, final_sha256').eq('id', id.data).maybeSingle();
  if (!env || env.status === 'draft') return json(404, { error: 'Document not found.' });
  if (!(await allow({ bucket: 'audit_export_user', limit: 60, windowSeconds: 3600 }, auth.user.id))) return json(429, { error: TOO_MANY });

  let trail;
  try {
    trail = await loadAuditTrail(env.id as string);
  } catch {
    return json(502, { error: 'The audit trail could not be loaded. Try again.' });
  }
  const generatedAt = new Date();
  let body: Uint8Array;
  if (format === 'json') {
    const doc = {
      format: 'younmesign-audit-export',
      v: 1,
      generated_at: generatedAt.toISOString(),
      document: { id: env.id, public_code: env.public_code, status: env.status, final_sha256: env.final_sha256 },
      chain: {
        key: trail.chainKey,
        events: trail.rows.length,
        head: trail.verify.head,
        verified: trail.verify.ok,
        ...(trail.verify.ok ? {} : { broken_at: trail.verify.brokenAt ?? null, reason: trail.verify.reason ?? null }),
        archived_parts: trail.archivedParts.map((p) => ({ first_seq: p.firstSeq, last_seq: p.lastSeq, file_sha256: p.fileSha256, file_ok: p.fileOk })),
        how_to_check:
          'event_hash = SHA-256(prev_hash bytes || UTF-8 bytes of canonical); the first prev_hash is 32 zero bytes; each prev_hash is the previous event_hash.',
      },
      events: trail.rows,
    };
    body = new TextEncoder().encode(JSON.stringify(doc, null, 2));
  } else {
    body = await buildAuditReport({
      publicCode: env.public_code as string,
      status: env.status as string,
      title: env.title as string,
      finalSha256: (env.final_sha256 as string | null) ?? null,
      rows: trail.rows,
      verified: trail.verify.ok,
      reason: trail.verify.reason,
      head: trail.verify.head,
      archivedParts: trail.archivedParts.length,
      generatedAt,
    });
  }

  const { ip, ua } = await requestEvidence();
  const logged = await supabaseAdmin().rpc('record_audit_export', { p_actor: auth.user.id, p_envelope_id: env.id, p_format: format, p_ip: ip, p_user_agent: ua });
  if (logged.error) return json(502, { error: 'The export could not be recorded, so it was not given out. Try again.' });

  return new Response(Buffer.from(body), {
    status: 200,
    headers: {
      'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Content-Disposition': `attachment; filename="${env.public_code} - audit trail.${format}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
