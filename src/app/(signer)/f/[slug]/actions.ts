'use server';
// D-87 (AT4.3): someone fills in a public form. Checks (in this order): the trap field, the page's signed load time,
// the per-IP limit, then the database's own limits for the form (counted under a lock). Then the document is made from
// the template on behalf of the form's owner, sent with this person's own link, and opened for them to sign now.
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { env } from '@/lib/env';
import { friendlyDbError } from '@/lib/db-error';
import { signerDbError } from '@/i18n/db-messages';
import type { MessageKey } from '@/i18n/format';
import { signerI18n } from '@/i18n/server';
import { checkFormToken, SLUG } from '@/lib/power-form';
import { allow, clientIp } from '@/lib/rate-limit';
import { mintTokenRecord } from '@/lib/signing/links';
import { requestEvidence, signerCookieName, signerCookieOptions, SIGNER_SESSION_TTL_SECONDS } from '@/lib/signing/session';
import { signSession } from '@/lib/signer-token';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';
import { draftFromTemplate, TemplateUseError } from '@/lib/template-use';

const input = z.object({
  slug: z.string().regex(SLUG),
  // messages are keys, worded in the person's language below
  name: z.string().trim().min(1, 'form.errName').max(120, 'form.errNameLong'),
  email: z.string().trim().toLowerCase().max(254, 'form.errEmail').pipe(z.email('form.errEmail')),
  website: z.string().max(200), // the trap: people never see it, so it stays empty
  token: z.string().max(100),
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function submitPowerFormAction(raw: { slug: string; name: string; email: string; website: string; token: string }): Promise<{ ok: false; message: string }> {
  const { t } = await signerI18n();
  const REFUSED = t('form.errRefused');
  const parsed = input.safeParse(raw);
  if (!parsed.success) {
    const k = parsed.error.issues[0]?.message ?? '';
    return { ok: false, message: k.startsWith('form.') ? t(k as MessageKey) : REFUSED };
  }
  const { slug, name, email, website, token } = parsed.data;
  if (website.trim() !== '') return { ok: false, message: REFUSED };
  const age = checkFormToken(env.sessionCookieKey(), slug, token);
  if (age === 'too_fast') return { ok: false, message: t('form.errTooFast') };
  if (age !== 'ok') return { ok: false, message: t('form.errOld') };
  const ip = await clientIp();
  if (!(await allow({ bucket: 'powerform_ip', limit: 30, windowSeconds: 600 }, ip))) return { ok: false, message: t('common.tooMany') };

  const admin = supabaseAdmin();
  const begun = await admin.rpc('power_form_begin', { p_slug: slug, p_ip_sha256: sha(`ip|${ip}`), p_email_sha256: sha(`email|${email}`) });
  if (begun.error) return { ok: false, message: signerDbError(t, begun.error.message).message };
  const b = begun.data as { submission_id: string; template_id: string; role_id: string; owner_id: string; title: string; email_check: boolean };
  const fail = async (envelopeId: string | null, reason: string, message: string) => {
    await admin.rpc('power_form_finish', { p_submission_id: b.submission_id, p_envelope_id: null, p_ok: false, p_reason: reason });
    if (envelopeId) {
      // a draft that never went out is removed, file included
      const del = await admin.rpc('delete_draft_envelope', { p_actor: b.owner_id, p_envelope_id: envelopeId });
      for (const row of (del.data ?? []) as { storage_backend: Backend; storage_path: string }[]) {
        await getStorageFor(row.storage_backend).remove('originals', row.storage_path, { draftOnly: true }).catch(() => {});
      }
    }
    return { ok: false as const, message };
  };

  let envelopeId: string;
  try {
    envelopeId = await draftFromTemplate(b.owner_id, b.template_id, `${b.title} — ${name}`.slice(0, 200), [{ role_id: b.role_id, name, email }]);
  } catch (e) {
    return fail(null, e instanceof Error ? e.message : 'could not make the document', e instanceof TemplateUseError ? e.message : t('form.errPrepare'));
  }
  const { data: person } = await admin.from('recipients').select('id').eq('envelope_id', envelopeId).single();
  if (!person) return fail(envelopeId, 'no recipient', t('form.errPrepare'));
  if (b.email_check) {
    const auth = await admin.rpc('set_recipient_auth', { p_actor: b.owner_id, p_envelope_id: envelopeId, p_recipient_id: person.id, p_method: 'email_otp', p_access_code_hash: null });
    if (auth.error) return fail(envelopeId, auth.error.message, t('form.errPrepare'));
  }
  const link = mintTokenRecord(person.id as string);
  const sent = await admin.rpc('send_envelope', {
    p_actor: b.owner_id,
    p_envelope_id: envelopeId,
    p_tokens: [link],
    p_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    p_delivery: 'link',
  });
  if (sent.error) {
    const f = friendlyDbError(sent.error.message);
    // the owner's own daily limits, or their account: the visitor is not told the details
    return fail(envelopeId, sent.error.message, f.code === 'ES_ENVELOPE_CAP' || f.code === 'ES_RECIPIENT_CAP' ? t('form.errCapToday') : t('form.errNotNow'));
  }
  await admin.rpc('power_form_finish', { p_submission_id: b.submission_id, p_envelope_id: envelopeId, p_ok: true, p_reason: null });

  // open the signing session in this browser, the same way a link does
  const ev = await requestEvidence();
  const opened = await admin.rpc('signer_open', { p_token_sha256: link.token_sha256, p_ip: ev.ip, p_user_agent: ev.ua });
  const row = Array.isArray(opened.data) ? opened.data[0] : null;
  if (opened.error || !row) return { ok: false, message: t('form.errOpenFailed') };
  const cookie = signSession({ tokenId: link.token_id, recipientId: person.id as string, envelopeId, level: 'link' }, env.sessionCookieKey(), { ttlSeconds: SIGNER_SESSION_TTL_SECONDS });
  (await cookies()).set(signerCookieName(), cookie, signerCookieOptions());
  redirect('/sign');
}
