// GET /api/envelopes/{id}/attachments/{fieldId}  -> a file a signer attached (Phase 4 slice 3, D-78).
// Authorisation by row-level security, as for the document itself: the lookup runs with the person's own session, so an
// attachment of a document they may not see does not exist for them. Only then does the server fetch the bytes.
// Always sent as a download (never shown inline), with the checksum it was stored with.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, requireApiUser } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

const TYPE = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg' } as const;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; fieldId: string }> }) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const p = await params;
  const id = z.uuid().safeParse(p.id);
  const fieldId = z.uuid().safeParse(p.fieldId);
  if (!id.success || !fieldId.success) return json(404, { error: 'Attachment not found.' });

  const supabase = await createSupabaseServerClient();
  const { data: visible } = await supabase.from('field_attachments').select('field_id, file_name, kind, sha256').eq('envelope_id', id.data).eq('field_id', fieldId.data).maybeSingle();
  if (!visible) return json(404, { error: 'Attachment not found.' });
  // the stored path is not readable from a person's session; the server looks it up only after the check above
  const { data: row } = await supabaseAdmin().from('field_attachments').select('storage_backend, storage_path').eq('field_id', fieldId.data).single();
  if (!row) return json(404, { error: 'Attachment not found.' });
  try {
    const bytes = await getStorageFor(row.storage_backend as Backend).get('attachments', row.storage_path as string);
    const safeName = String(visible.file_name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'attachment';
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': TYPE[visible.kind as keyof typeof TYPE] ?? 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${visible.sha256}"`,
      },
    });
  } catch {
    return json(502, { error: 'The attachment could not be loaded. Try again.' });
  }
}
