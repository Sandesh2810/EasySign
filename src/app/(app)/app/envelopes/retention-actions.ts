'use server';
// Retention, legal hold and deletion (Phase 3 slice 6, AT3.6, D-71). The database decides who may do what
// (owner only for deletion and the retention period; owner or platform admin for a hold) and whether the
// retention period is over; this file adds what the database cannot see: a fresh authenticator code.
import { isIP } from 'node:net';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { DANGEROUS_ACTION_FRESH_SECONDS, usedAuthenticatorWithin } from '@/lib/auth/mfa-policy';
import { mfaStatus, requireUser, type SessionUser } from '@/lib/auth/session';
import { clientIp, userAgent } from '@/lib/rate-limit';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import { StorageError } from '@/storage/types';
import type { Backend, Bucket } from '@/storage/types';

export type RetentionResult = { ok: true; message?: string } | { ok: false; message: string };

const NO_MFA = 'This needs two-step sign-in. Switch it on under Security first; then you will be asked for a code from your authenticator app.';

/** A code from the last 10 minutes, or off to the code page and back here. */
async function requireRecentCode(user: SessionUser, back: string): Promise<RetentionResult | null> {
  if (!(await mfaStatus(user.id)).enrolled) return { ok: false, message: NO_MFA };
  if (!usedAuthenticatorWithin({ aal: user.aal, amr: user.amr, nowSeconds: Date.now() / 1000, seconds: DANGEROUS_ACTION_FRESH_SECONDS })) {
    redirect(`/mfa?next=${encodeURIComponent(back)}&fresh=1`);
  }
  return null;
}

async function evidence() {
  const ip = await clientIp();
  return { ip: isIP(ip) ? ip : null, ua: (await userAgent()).slice(0, 500) };
}

export async function setLegalHoldAction(_prev: RetentionResult | null, formData: FormData): Promise<RetentionResult> {
  const user = await requireUser();
  const parsed = z
    .object({ envelope_id: z.uuid(), on: z.enum(['1', '0']), reason: z.string().max(500) })
    .safeParse({ envelope_id: formData.get('envelope_id'), on: formData.get('on'), reason: formData.get('reason') ?? '' });
  if (!parsed.success) return { ok: false, message: 'Keep the reason under 500 characters.' };
  const { error } = await supabaseAdmin().rpc('set_legal_hold', { p_actor: user.id, p_envelope_id: parsed.data.envelope_id, p_on: parsed.data.on === '1', p_reason: parsed.data.reason });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${parsed.data.envelope_id}`);
  return { ok: true, message: parsed.data.on === '1' ? 'Legal hold set. This document cannot be deleted until it is released.' : 'Legal hold released.' };
}

/** Deletes a finished document: database step, every stored file, database step (AT3.6: storage and DB together). */
export async function deleteEnvelopeAction(_prev: RetentionResult | null, formData: FormData): Promise<RetentionResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get('envelope_id'));
  if (!id.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  const back = `/app/envelopes/${id.data}`;
  const db = supabaseAdmin();
  const { data: env } = await db.from('envelopes').select('public_code').eq('id', id.data).maybeSingle();
  const typed = String(formData.get('confirm_code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!env || typed !== String(env.public_code).replace(/[^A-Z0-9]/g, '')) {
    return { ok: false, message: 'Type the verification code of this document exactly as shown, to confirm.' };
  }
  const blocked = await requireRecentCode(user, back);
  if (blocked) return blocked;

  const { ip, ua } = await evidence();
  const begun = await db.rpc('begin_envelope_deletion', { p_actor: user.id, p_envelope_id: id.data, p_ip: ip, p_user_agent: ua });
  if (begun.error) return { ok: false, message: friendlyDbError(begun.error.message).message };
  const files = (Array.isArray(begun.data) ? begun.data : []) as { bucket: Bucket; backend: Backend | null; path: string }[];
  let removed = 0;
  for (const f of files) {
    try {
      await getStorageFor((f.backend ?? 'supabase') as Backend).remove(f.bucket, f.path, { deletionStarted: true });
      removed += 1;
    } catch (e) {
      if (!(e instanceof StorageError && e.code === 'NOT_FOUND')) {
        // the deletion stays started; pressing Delete again continues where it stopped
        return { ok: false, message: 'Some stored files could not be removed yet. Nothing else was changed. Try again in a minute.' };
      }
    }
  }
  const done = await db.rpc('finish_envelope_deletion', { p_actor: user.id, p_envelope_id: id.data, p_files_removed: removed, p_ip: ip, p_user_agent: ua });
  if (done.error) return { ok: false, message: friendlyDbError(done.error.message).message };
  revalidatePath(back);
  return { ok: true, message: 'Deleted.' };
}

export async function setRetentionAction(_prev: RetentionResult | null, formData: FormData): Promise<RetentionResult> {
  const user = await requireUser('/app/settings');
  const parsed = z.object({ org_id: z.uuid(), years: z.coerce.number().int().min(0).max(30) }).safeParse({ org_id: formData.get('org_id'), years: formData.get('years') });
  if (!parsed.success) return { ok: false, message: 'Choose between 0 and 30 years.' };
  const blocked = await requireRecentCode(user, '/app/settings');
  if (blocked) return blocked;
  const { error } = await supabaseAdmin().rpc('set_retention_years', { p_actor: user.id, p_org: parsed.data.org_id, p_years: parsed.data.years });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath('/app/settings');
  return { ok: true, message: 'Saved.' };
}
