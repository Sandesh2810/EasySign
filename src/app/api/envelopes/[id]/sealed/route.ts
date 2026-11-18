// GET /api/envelopes/{id}/sealed[?part=certificate] -> the completed file for a signed-in member of the workspace.
// Authorisation is row-level security: the lookup runs with the user's own session.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, requireApiUser } from '@/lib/request-guard';
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
    .select('title, status, sealed_storage_backend, sealed_storage_path, certificate_storage_path')
    .eq('id', id.data)
    .maybeSingle();
  if (!env || env.status !== 'completed' || !env.sealed_storage_path || !env.certificate_storage_path) return json(404, { error: 'Document not found.' });

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
