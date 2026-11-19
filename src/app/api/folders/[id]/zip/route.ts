// GET /api/folders/{id}/zip -> every completed document in the folder (signed PDF + certificate) as one ZIP.
// Streamed: files are fetched and sent one at a time, so the server holds about one file in memory (AT2.12).
// Authorisation is row-level security: the folder and its documents are read with the user's own session.
// Every file is recorded as a download in its document's audit trail before it is sent.
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { json, requireApiUser } from '@/lib/request-guard';
import { requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { zipStream, ZIP_MAX_FILES, type ZipSource } from '@/lib/zip-stream';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

const MAX_DOCUMENTS = 500;
const fileBase = (s: string) => s.replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 80) || 'document';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request, { mutation: false });
  if ('response' in auth) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return json(404, { error: 'Folder not found.' });
  if (!(await allow({ bucket: 'zip_user', limit: 10, windowSeconds: 3600 }, auth.user.id))) return json(429, { error: TOO_MANY });

  const supabase = await createSupabaseServerClient();
  const { data: folder } = await supabase.from('folders').select('id, name').eq('id', id.data).maybeSingle();
  if (!folder) return json(404, { error: 'Folder not found.' });
  const { data: docs } = await supabase
    .from('envelopes')
    .select('id, title, public_code, completed_at, sealed_storage_backend, sealed_storage_path, certificate_storage_path')
    .eq('folder_id', folder.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: true })
    .limit(MAX_DOCUMENTS + 1);
  const list = (docs ?? []).filter((d) => d.sealed_storage_path && d.certificate_storage_path);
  if (list.length === 0) return json(404, { error: 'There are no completed documents in this folder yet.' });
  if (list.length > MAX_DOCUMENTS || list.length * 2 > ZIP_MAX_FILES) return json(413, { error: `A folder can be downloaded with up to ${MAX_DOCUMENTS} completed documents at a time.` });

  const { ip, ua } = await requestEvidence();
  const admin = supabaseAdmin();
  const actor = auth.user.id;
  async function* sources(): AsyncGenerator<ZipSource> {
    for (const d of list) {
      // the code keeps two documents with the same title apart inside the ZIP
      const dir = `${fileBase(d.title as string)} (${d.public_code})`;
      const storage = getStorageFor(d.sealed_storage_backend as Backend);
      for (const part of ['sealed', 'certificate'] as const) {
        yield {
          name: `${dir}/${fileBase(d.title as string)} - ${part === 'sealed' ? 'signed' : 'certificate'}.pdf`,
          date: d.completed_at ? new Date(d.completed_at as string) : undefined,
          load: async () => {
            const logged = await admin.rpc('record_download', { p_actor: actor, p_token_id: null, p_envelope_id: d.id, p_part: part, p_ip: ip, p_user_agent: ua });
            if (logged.error) throw new Error('A download could not be recorded, so the ZIP was stopped.');
            return storage.get('sealed', (part === 'sealed' ? d.sealed_storage_path : d.certificate_storage_path) as string);
          },
        };
      }
    }
  }

  const stream = zipStream(sources(), (e) => console.error(`folder zip stopped: ${e instanceof Error ? e.message : 'unknown error'}`));
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileBase(folder.name as string)} - completed documents.zip"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
