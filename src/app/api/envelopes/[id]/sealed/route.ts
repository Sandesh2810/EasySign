// GET /api/envelopes/{id}/sealed[?part=certificate] -> the completed file for a signed-in member of the workspace.
// Authorisation is row-level security: the lookup runs with the user's own session.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { json, requireApiUser } from '@/lib/request-guard';
import { requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return json(404, { error: 'Document not found.' });
  const certificate = request.nextUrl.searchParams.get('part') === 'certificate';

  const supabase = await createSupabaseServerClient();
  const { data: env } = await supabase
    .from('envelopes')
    .select('title, status, sealed_storage_backend, sealed_storage_path, certificate_storage_path, deleted_at')
    .eq('id', id.data)
    .maybeSingle();
  if (!env || env.status !== 'completed' || !env.sealed_storage_path || !env.certificate_storage_path) return json(404, { error: 'Document not found.' });
  if (env.deleted_at) return json(410, { error: 'This document was deleted by the workspace owner.' });

  // Every download is written to the document's audit trail first; if that fails, nothing is served.
  if (!(await allow({ bucket: 'download_user', limit: 120, windowSeconds: 3600 }, auth.user.id))) return json(429, { error: TOO_MANY });
  const { ip, ua } = await requestEvidence();
  const logged = await supabaseAdmin().rpc('record_download', {
    p_actor: auth.user.id,
    p_token_id: null,
    p_envelope_id: id.data,
    p_part: certificate ? 'certificate' : 'sealed',
    p_ip: ip,
    p_user_agent: ua,
  });
  if (logged.error) return json(502, { error: 'The file could not be prepared. Try again.' });

  try {
    const bytes = await getStorageFor(env.sealed_storage_backend as Backend).get('sealed', (certificate ? env.certificate_storage_path : env.sealed_storage_path) as string);
    const base = String(env.title).replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 80) || 'document';
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${base}${certificate ? ' - certificate' : ' - signed'}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return json(502, { error: 'The file could not be loaded. Try again.' });
  }
}
