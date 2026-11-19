// GET /api/sign/document            -> the original PDF, for the signer's own viewer
// GET /api/sign/document?part=sealed|certificate -> the completed file, once everyone has signed
// GET /api/sign/document?part=signature|initials -> the signer's own adopted signature image
// Authorised by the signer session cookie, re-checked against the live link on every request.
import type { NextRequest } from 'next/server';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { json } from '@/lib/request-guard';
import { loadSignerContext, requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

const fileName = (title: string, suffix: string) => `${title.replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 80) || 'document'}${suffix}.pdf`;

function send(bytes: Uint8Array, type: string, disposition: string) {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': disposition,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: NextRequest) {
  const ctx = await loadSignerContext();
  if (!ctx) return json(401, { error: 'Open your signing link again.' });
  if (ctx.onHold) return json(423, { error: 'This document is on hold and cannot be opened right now.' });
  // a page view needs two or three files; this stops one link being used to pull the file in a loop
  if (!(await allow({ bucket: 'sign_file', limit: 240, windowSeconds: 3600 }, ctx.tokenId))) return json(429, { error: TOO_MANY });
  const part = request.nextUrl.searchParams.get('part') ?? 'original';
  const env = ctx.envelope;
  const admin = supabaseAdmin();

  try {
    if (part === 'original') {
      if (!['sent', 'in_progress', 'completed'].includes(env.status)) return json(404, { error: 'This document is no longer available.' });
      const { data: doc } = await admin.from('envelope_documents').select('storage_backend, storage_path').eq('envelope_id', env.id).order('position').limit(1).maybeSingle();
      if (!doc) return json(404, { error: 'Document not found.' });
      return send(await getStorageFor(doc.storage_backend as Backend).get('originals', doc.storage_path as string), 'application/pdf', 'inline');
    }
    if (part === 'sealed' || part === 'certificate') {
      if (env.status !== 'completed' || !env.sealed_storage_path || !env.certificate_storage_path) return json(404, { error: 'The completed document is not ready yet.' });
      // written to the audit trail first; if that fails, nothing is served
      const { ip, ua } = await requestEvidence();
      const logged = await admin.rpc('record_download', { p_actor: null, p_token_id: ctx.tokenId, p_envelope_id: env.id, p_part: part, p_ip: ip, p_user_agent: ua });
      if (logged.error) return json(502, { error: 'The file could not be prepared. Try again.' });
      const path = part === 'sealed' ? env.sealed_storage_path : env.certificate_storage_path;
      const bytes = await getStorageFor(env.sealed_storage_backend as Backend).get('sealed', path);
      return send(bytes, 'application/pdf', `attachment; filename="${fileName(env.title, part === 'sealed' ? ' - signed' : ' - certificate')}"`);
    }
    if (part === 'signature' || part === 'initials') {
      const { data: asset } = await admin
        .from('signature_assets')
        .select('storage_backend, storage_path')
        .eq('recipient_id', ctx.recipient.id)
        .eq('kind', part)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!asset) return json(404, { error: 'Not found.' });
      return send(await getStorageFor(asset.storage_backend as Backend).get('signatures', asset.storage_path as string), 'image/png', 'inline');
    }
    return json(404, { error: 'Not found.' });
  } catch {
    return json(502, { error: 'The file could not be loaded. Try again.' });
  }
}
