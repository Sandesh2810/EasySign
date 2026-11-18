// Sealing: turn a fully signed envelope into the final PDF and its certificate (ARCHITECTURE section 5).
// The database hands out one job at a time under a lease; the attempt id it returns fences the final
// write, so a slow worker that lost its lease cannot complete the envelope a second time.
import { createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { buildSealedPdf, type SealField, type SealInput, type SealRecipient } from '@/pdf/seal';
import { getStorage, getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

interface ClaimedJob {
  envelope_id: string;
  attempt_id: string;
  attempts: number;
  audit_seq: number;
  audit_hash: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const date = (v: unknown) => (v ? new Date(v as string) : undefined);

async function must<T>(q: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await q;
  if (error || data === null || data === undefined) throw new Error(`could not load ${what}`);
  return data;
}

async function buildInput(job: ClaimedJob): Promise<{ input: SealInput; orgId: string }> {
  const db = supabaseAdmin();
  const id = job.envelope_id;
  const envelope = await must(db.from('envelopes').select('id, org_id, title, public_code, sender_id, delivery').eq('id', id).maybeSingle(), 'the envelope');
  const doc = await must(db.from('envelope_documents').select('storage_backend, storage_path, sha256').eq('envelope_id', id).order('position').limit(1).maybeSingle(), 'the document');
  const recipients = await must(db.from('recipients').select('id, name, email, role, routing_order, auth_method, sent_at, viewed_at, consented_at, completed_at').eq('envelope_id', id).order('routing_order'), 'the recipients');
  const fields = await must(db.from('fields').select('id, recipient_id, type, page, x, y, w, h').eq('envelope_id', id), 'the fields');
  const values = await must(db.from('field_values').select('field_id, value_text, signature_asset_id, signature_id').eq('envelope_id', id), 'the field values');
  const consents = await must(db.from('consents').select('recipient_id, disclosure_version, ip, user_agent, given_at').eq('envelope_id', id).order('given_at'), 'the consent records');
  const recipientIds = recipients.map((r) => r.id as string);
  const assets = await must(db.from('signature_assets').select('id, recipient_id, kind, method, storage_backend, storage_path, sha256').in('recipient_id', recipientIds), 'the signatures');
  const profile = await must(db.from('profiles').select('display_name').eq('id', envelope.sender_id).maybeSingle(), 'the sender');
  const sender = await db.auth.admin.getUserById(envelope.sender_id as string);
  if (sender.error || !sender.data.user?.email) throw new Error('could not load the sender');

  const original = await getStorageFor(doc.storage_backend as Backend).get('originals', doc.storage_path as string);
  if (sha256(original) !== doc.sha256) throw new Error('the stored original does not match its recorded SHA-256');

  const valueOf = new Map(values.map((v) => [v.field_id as string, v]));
  const assetOf = new Map(assets.map((a) => [a.id as string, a]));
  const recipientOf = new Map(recipients.map((r) => [r.id as string, r]));
  const images = new Map<string, Uint8Array>();
  const sealFields: SealField[] = [];
  for (const f of fields) {
    const v = valueOf.get(f.id as string);
    const rect = { x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) };
    if (f.type === 'signature' || f.type === 'initials') {
      const asset = v?.signature_asset_id ? assetOf.get(v.signature_asset_id as string) : undefined;
      const who = recipientOf.get(f.recipient_id as string);
      if (!v?.signature_id || !asset || !who?.completed_at) throw new Error('a signature field has no signature');
      let png = images.get(asset.id as string);
      if (!png) {
        png = await getStorageFor(asset.storage_backend as Backend).get('signatures', asset.storage_path as string);
        if (sha256(png) !== asset.sha256) throw new Error('a stored signature image does not match its recorded SHA-256');
        images.set(asset.id as string, png);
      }
      sealFields.push({ page: f.page as number, rect, kind: f.type, imagePng: png, signerName: who.name as string, signedAtUtc: new Date(who.completed_at as string), signatureId: v.signature_id as string });
    } else if (v?.value_text) {
      sealFields.push({ page: f.page as number, rect, kind: 'text', text: v.value_text as string });
    }
  }

  const sealRecipients: SealRecipient[] = recipients.map((r) => {
    const consent = consents.filter((c) => c.recipient_id === r.id).at(-1);
    // the signature actually applied to this signer's fields, not merely the last one they tried
    const applied = fields.find((f) => f.recipient_id === r.id && f.type === 'signature');
    const signature = applied ? assetOf.get(valueOf.get(applied.id as string)?.signature_asset_id as string) : undefined;
    return {
      id: r.id as string,
      name: r.name as string,
      email: r.email as string,
      role: r.role as SealRecipient['role'],
      order: r.routing_order as number,
      authMethod: r.auth_method as SealRecipient['authMethod'],
      consentVersion: (consent?.disclosure_version as string | undefined) ?? null,
      signatureMethod: (signature?.method as SealRecipient['signatureMethod']) ?? null,
      ip: (consent?.ip as string | null | undefined) ?? null,
      userAgent: (consent?.user_agent as string | null | undefined) ?? null,
      region: null,
      timeline: { sent: date(r.sent_at), viewed: date(r.viewed_at), consented: date(r.consented_at), completed: date(r.completed_at) },
    };
  });
  const finished = recipients.map((r) => (r.completed_at ? new Date(r.completed_at as string).getTime() : 0));

  return {
    orgId: envelope.org_id as string,
    input: {
      original,
      envelope: {
        id,
        publicCode: envelope.public_code as string,
        title: envelope.title as string,
        originalSha256: doc.sha256 as string,
        verifyUrl: `${env.appUrl()}/verify?code=${envelope.public_code}`,
        completedAtUtc: new Date(Math.max(...finished)),
        sender: { name: (profile.display_name as string) || sender.data.user.email, email: sender.data.user.email },
        delivery: envelope.delivery === 'link' ? 'link' : 'email',
      },
      recipients: sealRecipients,
      fields: sealFields,
      audit: { checkpointSeq: job.audit_seq, checkpointHash: job.audit_hash },
    },
  };
}

/** Claims and runs at most one seal job. Returns what happened so the loop can decide whether to look again at once. */
export async function runOneSealJob(log: (msg: string) => void): Promise<'none' | 'sealed' | 'lost' | 'retry' | 'failed'> {
  const db = supabaseAdmin();
  const claim = await db.rpc('claim_seal_job', { p_lease_seconds: 300 });
  if (claim.error) throw new Error(`claim_seal_job: ${claim.error.message}`);
  const job = (Array.isArray(claim.data) ? claim.data[0] : null) as ClaimedJob | null;
  if (!job) return 'none';

  const storage = getStorage();
  let written: string[] = [];
  try {
    const { input, orgId } = await buildInput(job);
    const out = await buildSealedPdf(input);
    const sealedPath = `${orgId}/${job.envelope_id}/sealed-${job.attempt_id}.pdf`;
    const certificatePath = `${orgId}/${job.envelope_id}/certificate-${job.attempt_id}.pdf`;
    written = [sealedPath, certificatePath];
    await storage.put('sealed', sealedPath, out.sealed, { contentType: 'application/pdf' });
    await storage.put('sealed', certificatePath, out.certificate, { contentType: 'application/pdf' });
    const done = await db.rpc('complete_seal_job', {
      p_envelope_id: job.envelope_id,
      p_attempt_id: job.attempt_id,
      p_preseal_sha256: out.presealSha256,
      p_final_sha256: out.finalSha256,
      p_storage_backend: storage.backend,
      p_sealed_path: sealedPath,
      p_certificate_path: certificatePath,
      p_audit_seq: job.audit_seq,
      p_audit_hash: job.audit_hash,
    });
    if (done.error) throw new Error(`complete_seal_job: ${done.error.message}`);
    if (done.data !== true) {
      // another attempt owns this job now; our files are not referenced by anything
      await storage.remove('sealed', sealedPath).catch(() => {});
      await storage.remove('sealed', certificatePath).catch(() => {});
      log(`seal ${job.envelope_id}: lease lost, result discarded`);
      return 'lost';
    }
    log(`seal ${job.envelope_id}: completed (${out.pageCount} pages + ${out.certificatePages} certificate, sha256 ${out.finalSha256.slice(0, 12)}…)${out.warnings.length ? ` warnings: ${out.warnings.join(' | ')}` : ''}`);
    return 'sealed';
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    const failed = await db.rpc('fail_seal_job', { p_envelope_id: job.envelope_id, p_attempt_id: job.attempt_id, p_error: message });
    // The database confirmed this attempt is over (retry or failed), so its files are referenced by
    // nothing: remove them. If the answer is unclear ("ignored" or no answer) they are left alone.
    if (failed.data === 'retry' || failed.data === 'failed') for (const p of written) await storage.remove('sealed', p).catch(() => {});
    log(`seal ${job.envelope_id}: attempt ${job.attempts} failed (${message}) -> ${failed.data ?? failed.error?.message}`);
    return failed.data === 'failed' ? 'failed' : 'retry';
  }
}
