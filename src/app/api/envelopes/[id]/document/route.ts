// GET /api/envelopes/{id}/document  -> the original PDF, for the signed-in owner's viewer and editor.
// Authorisation is decided by row-level security: the lookup runs with the user's own session, so a
// document outside their workspace simply does not exist for them. Only then does the server fetch
// the bytes with its own key.
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

  const supabase = await createSupabaseServerClient();
  const { data: doc } = await supabase.from('envelope_documents').select('storage_backend, storage_path, sha256').eq('envelope_id', id.data).order('position').limit(1).maybeSingle();
  if (!doc) return json(404, { error: 'Document not found.' });

  try {
    const bytes = await getStorageFor(doc.storage_backend as Backend).get('originals', doc.storage_path as string);
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.length),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${doc.sha256}"`,
      },
    });
  } catch {
    return json(502, { error: 'The document could not be loaded. Try again.' });
  }
}
