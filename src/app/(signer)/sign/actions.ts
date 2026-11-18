'use server';
// What a signer can do. There is no account: each action re-loads the signer from the session cookie
// and the live link, then calls a server-only database function that re-checks the link, the envelope
// state and the signer's own progress. Evidence (IP, browser) is recorded with every step.
import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import sharp from 'sharp';
import { z } from 'zod';
import { CONSENT_TEXT, CONSENT_VERSION, INTENT_TEXT } from '@/config/legal';
import { allow, TOO_MANY } from '@/lib/rate-limit';
import { friendlyDbError } from '@/lib/request-guard';
import { loadSignerContext, requestEvidence } from '@/lib/signing/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorage } from '@/storage';

export type SignResult = { ok: true } | { ok: false; message: string };

const EXPIRED = 'Your signing session has ended. Open the link from your email again.';
const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export async function consentAction(_prev: SignResult | null, formData: FormData): Promise<SignResult> {
  const ctx = await loadSignerContext();
  if (!ctx) return { ok: false, message: EXPIRED };
  if (formData.get('agree') !== 'on') return { ok: false, message: 'Tick the box to agree, or close this page to sign on paper instead.' };
  const { ip, ua } = await requestEvidence();
  const { error } = await supabaseAdmin().rpc('signer_consent', {
    p_token_id: ctx.tokenId,
    p_version: CONSENT_VERSION,
    p_disclosure_sha256: sha256Hex(CONSENT_TEXT),
    p_ip: ip,
    p_user_agent: ua,
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/sign');
  return { ok: true };
}

export async function fillFieldAction(fieldId: string, value: string): Promise<SignResult> {
  const ctx = await loadSignerContext();
  if (!ctx) return { ok: false, message: EXPIRED };
  // every change is written to the audit trail, so the number of changes per link is bounded
  if (!(await allow({ bucket: 'sign_fill', limit: 300, windowSeconds: 3600 }, ctx.tokenId))) return { ok: false, message: TOO_MANY };
  const id = z.uuid().safeParse(fieldId);
  const text = z.string().max(500).safeParse(value);
  if (!id.success || !text.success) return { ok: false, message: 'That value could not be saved. Keep it under 500 characters.' };
  const { ip, ua } = await requestEvidence();
  const { error } = await supabaseAdmin().rpc('signer_fill_field', { p_token_id: ctx.tokenId, p_field_id: id.data, p_value: text.data, p_ip: ip, p_user_agent: ua });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  return { ok: true };
}

const adoptSchema = z.object({
  kind: z.enum(['signature', 'initials']),
  method: z.enum(['drawn', 'typed', 'uploaded']),
  typed_text: z.string().trim().max(120),
});
const MAX_SIGNATURE_BYTES = 400 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The browser sends a PNG (drawn, typed or made from an upload). It is decoded and re-encoded here, never stored as received. */
export async function adoptSignatureAction(formData: FormData): Promise<SignResult> {
  const ctx = await loadSignerContext();
  if (!ctx) return { ok: false, message: EXPIRED };
  if (!(await allow({ bucket: 'sign_adopt', limit: 30, windowSeconds: 3600 }, ctx.tokenId))) return { ok: false, message: TOO_MANY };
  const parsed = adoptSchema.safeParse({ kind: formData.get('kind'), method: formData.get('method'), typed_text: formData.get('typed_text') ?? '' });
  const file = formData.get('image');
  if (!parsed.success || !(file instanceof File)) return { ok: false, message: 'That signature could not be read. Try again.' };
  if (file.size === 0 || file.size > MAX_SIGNATURE_BYTES) return { ok: false, message: 'That signature image is too large. Try a simpler one.' };
  const input = new Uint8Array(await file.arrayBuffer());
  if (!PNG_MAGIC.every((b, i) => input[i] === b)) return { ok: false, message: 'That signature could not be read. Try again.' };

  let png: Buffer;
  try {
    const base = sharp(input, { limitInputPixels: 4_000_000, failOn: 'error' }).ensureAlpha();
    const stats = await base.clone().stats();
    if (stats.channels.length < 4 || stats.channels[3].max < 24) return { ok: false, message: parsed.data.kind === 'signature' ? 'Draw or type your signature first.' : 'Draw or type your initials first.' };
    const trimmed = await base
      .clone()
      .trim({ threshold: 1 })
      .toBuffer()
      .catch(() => base.clone().toBuffer());
    png = await sharp(trimmed).resize({ width: 900, height: 320, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return { ok: false, message: 'That signature could not be read. Try again.' };
  }

  const storage = getStorage();
  const path = `${ctx.envelope.org_id}/${ctx.envelope.id}/sig-${randomUUID()}.png`;
  try {
    await storage.put('signatures', path, new Uint8Array(png), { contentType: 'image/png' });
  } catch {
    return { ok: false, message: 'Your signature could not be saved. Try again.' };
  }
  const { ip, ua } = await requestEvidence();
  const { error } = await supabaseAdmin().rpc('signer_adopt_signature', {
    p_token_id: ctx.tokenId,
    p_kind: parsed.data.kind,
    p_method: parsed.data.method,
    p_storage_backend: storage.backend,
    p_storage_path: path,
    p_sha256: sha256Hex(png),
    p_typed_text: parsed.data.method === 'typed' ? parsed.data.typed_text : null,
    p_typed_font: parsed.data.method === 'typed' ? 'browser-script' : null,
    p_ip: ip,
    p_user_agent: ua,
  });
  if (error) {
    // Remove the image only when the database definitely refused it (a Postgres error code). After a
    // timeout or dropped connection the row may exist, and a row pointing at a missing file would block sealing.
    if (/^[0-9A-Z]{5}$/.test(error.code ?? '')) await storage.remove('signatures', path).catch(() => {});
    return { ok: false, message: friendlyDbError(error.message).message };
  }
  return { ok: true };
}

/** An approver's "yes". */
export async function approveAction(): Promise<SignResult> {
  const ctx = await loadSignerContext();
  if (!ctx) return { ok: false, message: EXPIRED };
  const { ip, ua } = await requestEvidence();
  const { error } = await supabaseAdmin().rpc('signer_approve', { p_token_id: ctx.tokenId, p_ip: ip, p_user_agent: ua });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/sign');
  return { ok: true };
}

/** Decline: stops the document for everyone and switches off every link, including this one. */
export async function declineAction(reason: string): Promise<SignResult> {
  const ctx = await loadSignerContext();
  if (!ctx) return { ok: false, message: EXPIRED };
  const text = z.string().max(1000).safeParse(reason ?? '');
  if (!text.success) return { ok: false, message: 'Keep the reason under 1000 characters.' };
  const { ip, ua } = await requestEvidence();
  const { error } = await supabaseAdmin().rpc('signer_decline', { p_token_id: ctx.tokenId, p_reason: text.data, p_ip: ip, p_user_agent: ua });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  return { ok: true };
}

export async function completeAction(localDate: string): Promise<SignResult> {
  const ctx = await loadSignerContext();
  if (!ctx) return { ok: false, message: EXPIRED };
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(localDate);
  if (!date.success) return { ok: false, message: 'Your device reported an unusual date. Check its clock and try again.' };
  const { ip, ua } = await requestEvidence();
  const { error } = await supabaseAdmin().rpc('signer_complete', {
    p_token_id: ctx.tokenId,
    p_intent_text_sha256: sha256Hex(INTENT_TEXT),
    p_local_date: date.data,
    p_ip: ip,
    p_user_agent: ua,
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/sign');
  return { ok: true };
}
