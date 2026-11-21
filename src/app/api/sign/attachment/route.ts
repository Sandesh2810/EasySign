// POST /api/sign/attachment  (multipart: field_id, file)  — a signer attaches a file to an attachment field (D-78).
// Signer session only; PDF, PNG or JPG recognised by content (not by name), up to 5 MB; stored under the document's own
// folder in the attachments store; the database checks the field, the person and the path again (signer_attach).
// A replaced file is removed. Nothing is ever served back to the signer from here.
import { createHash, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { PRODUCT_NAME } from '@/config/brand';
import { signerI18n } from '@/i18n/server';
import { signerDbError } from '@/i18n/db-messages';
import { allow } from '@/lib/rate-limit';
import { isSameOrigin, json } from '@/lib/request-guard';
import { loadSignerContext, requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sniffUpload } from '@/pdf/image-to-pdf';
import { inspectPdf } from '@/pdf/inspect';
import { getStorage } from '@/storage';

const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { pdf: 'pdf', png: 'png', jpeg: 'jpg' } as const;
const TYPE = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg' } as const;

export async function POST(request: NextRequest) {
  const { t } = await signerI18n();
  if (!isSameOrigin(request)) return json(403, { error: t('common.notFromUs', { product: PRODUCT_NAME }) });
  const ctx = await loadSignerContext();
  if (!ctx) return json(401, { error: t('attach.errOpenAgain') });
  if (ctx.onHold) return json(423, { error: t('attach.errHold') });
  if (!(await allow({ bucket: 'sign_attach', limit: 30, windowSeconds: 3600 }, ctx.tokenId))) return json(429, { error: t('common.tooMany') });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES + 256 * 1024) return json(413, { error: t('attach.errSize') });

  let fieldId = '';
  let file: File | null = null;
  try {
    const form = await request.formData();
    fieldId = String(form.get('field_id') ?? '');
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch {
    return json(400, { error: t('attach.errRead') });
  }
  if (!/^[0-9a-f-]{36}$/.test(fieldId) || !file || file.size === 0) return json(400, { error: t('attach.errChoose') });
  if (file.size > MAX_BYTES) return json(413, { error: t('attach.errSize') });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffUpload(bytes);
  if (!kind) return json(415, { error: t('attach.errType') });
  if (kind === 'pdf') {
    // D-89 F5: the sender will open this file; scripts, automatic actions, files hidden inside and decompression
    // bombs are refused (signed PDFs and form fields are fine in an attachment)
    const scan = await inspectPdf(bytes, { allowSealed: true });
    if (!scan.ok && (scan.code === 'ACTIVE_CONTENT' || scan.code === 'EMBEDDED_FILES' || scan.code === 'TOO_COMPLEX')) return json(415, { error: scan.message });
  }

  const env = ctx.envelope as { id: string; org_id: string };
  const path = `${env.org_id}/${env.id}/att-${randomUUID()}.${EXT[kind]}`;
  const store = getStorage();
  try {
    await store.put('attachments', path, bytes, { contentType: TYPE[kind] });
  } catch {
    return json(502, { error: t('attach.errStore') });
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const name = (file.name || `attachment.${EXT[kind]}`).replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  const { ip, ua } = await requestEvidence();
  const { data: old, error } = await supabaseAdmin().rpc('signer_attach', {
    p_token_id: ctx.tokenId, p_field_id: fieldId, p_storage_backend: store.backend, p_storage_path: path, p_file_name: name,
    p_kind: kind, p_size_bytes: bytes.length, p_sha256: sha, p_ip: ip, p_user_agent: ua,
  });
  if (error) {
    await store.remove('attachments', path).catch(() => {});
    return json(400, { error: signerDbError(t, error.message).message });
  }
  if (typeof old === 'string' && old) await store.remove('attachments', old).catch(() => {}); // the file it replaced
  return json(200, { ok: true, value: `${name.slice(0, 120)} · SHA-256 ${sha.slice(0, 16)}` });
}
