// POST /api/envelopes/upload  (multipart form: file)
// Validates the upload, converts images to PDF, stores the original (insert-only), creates a draft
// envelope and records the document. Everything is checked on the server; the browser is not trusted.
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { LIMITS } from '@/config/brand';
import { capacityBlock } from '@/lib/free-tier';
import { loadPlatformUsage } from '@/lib/platform-usage';
import { friendlyDbError, json, requireApiUser } from '@/lib/request-guard';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorage } from '@/storage';
import { activeWorkspace, canSend } from '@/lib/workspace';
import { imageToPdf, sniffUpload } from '@/pdf/image-to-pdf';
import { inspectPdf } from '@/pdf/inspect';

const UPLOADS_PER_HOUR = { bucket: 'upload_user', limit: 30, windowSeconds: 3600 };

export async function POST(request: NextRequest) {
  const auth = await requireApiUser(request, { mutation: true });
  if ('response' in auth) return auth.response;
  const { user } = auth;

  if (!(await allow(UPLOADS_PER_HOUR, user.id))) return json(429, { error: TOO_MANY });

  // brief: uploads stop, politely, when the free hosting plan is 90% full
  const usage = await loadPlatformUsage();
  const capacity = usage ? capacityBlock(usage) : { blocked: false as const };
  if (capacity.blocked) return json(507, { error: capacity.message });

  // Refuse oversized bodies before reading them (multipart overhead allowed for).
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > LIMITS.maxDocumentBytes + 1024 * 1024) return json(413, { error: 'Files can be up to 10 MB.' });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch {
    return json(400, { error: 'The upload could not be read. Try again.' });
  }
  if (!file || file.size === 0) return json(400, { error: 'Choose a PDF, PNG or JPG file to upload.' });
  if (file.size > LIMITS.maxDocumentBytes) return json(413, { error: 'Files can be up to 10 MB.' });

  const uploaded = new Uint8Array(await file.arrayBuffer());
  const kind = sniffUpload(uploaded);
  if (!kind) return json(415, { error: 'Only PDF, PNG and JPG files can be uploaded.' });

  let pdf: Uint8Array = uploaded;
  if (kind !== 'pdf') {
    const converted = await imageToPdf(uploaded);
    if (!converted.ok) return json(422, { error: converted.message });
    pdf = converted.pdf;
  }
  const info = await inspectPdf(pdf);
  if (!info.ok) return json(422, { error: info.message, code: info.code });

  const admin = supabaseAdmin();
  // the workspace the person is working in (create_envelope checks the membership again)
  const ws = await activeWorkspace(user.id).catch(() => null);
  if (!ws) return json(403, { error: 'No workspace was found for your account.' });
  if (!canSend(ws.current.role)) return json(403, { error: 'Viewers cannot add documents to this workspace.' });
  const orgId = ws.current.orgId;

  // Display name only; never used as a path. Strip directories and control characters.
  const displayName = (file.name || 'document').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'document';
  const title = displayName.replace(/\.(pdf|png|jpe?g)$/i, '').slice(0, 200) || 'Untitled document';

  const created = await admin.rpc('create_envelope', { p_actor: user.id, p_org_id: orgId, p_title: title, p_folder_id: null });
  if (created.error || !created.data) return json(403, friendlyError(created.error?.message));
  const envelope = created.data as { id: string };

  const storage = getStorage();
  const path = `${orgId}/${envelope.id}/${randomUUID()}.pdf`;
  const undo = async (stored: boolean) => {
    if (stored) await storage.remove('originals', path, { draftOnly: true }).catch(() => {});
    await admin.rpc('delete_draft_envelope', { p_actor: user.id, p_envelope_id: envelope.id });
  };

  try {
    await storage.put('originals', path, pdf, { contentType: 'application/pdf' });
  } catch {
    await undo(false);
    return json(502, { error: 'The file could not be stored. Nothing was saved. Try again.' });
  }

  const doc = await admin.rpc('add_envelope_document', {
    p_actor: user.id,
    p_envelope_id: envelope.id,
    p_filename: displayName,
    p_storage_backend: storage.backend,
    p_storage_path: path,
    p_sha256: info.sha256,
    p_page_count: info.pageCount,
    p_size_bytes: info.sizeBytes,
    p_page_boxes: info.pages,
    p_source_kind: kind,
  });
  if (doc.error) {
    await undo(true);
    const e = friendlyDbError(doc.error.message);
    return json(e.code === 'ES_QUOTA' ? 413 : 400, { error: e.message, code: e.code });
  }

  return json(201, { id: envelope.id, pages: info.pageCount, converted: kind !== 'pdf' });
}

function friendlyError(message: string | undefined) {
  const e = friendlyDbError(message);
  return { error: e.message, code: e.code };
}
