'use server';
// Actions on a draft envelope. Each one establishes the user first, then calls a server-only database
// function that re-checks that user's membership (DECISIONS D-35).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { checkAccessCode, hashAccessCode } from '@/lib/access-code';
import { fieldsSchema } from '@/lib/fields';
import { sendProblems, toLogicFields } from '@/lib/form-logic';
import { mirrorGroupFields } from '@/lib/groups';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { friendlyDbError } from '@/lib/request-guard';
import { assignOrders, MAX_RECIPIENTS, validateRouting } from '@/lib/routing';
import { mintTokenRecord, signingLink } from '@/lib/signing/links';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

const recipientsSchema = z.object({
  mode: z.enum(['sequential', 'parallel', 'mixed']),
  recipients: z
    .array(
      z.object({
        id: z.uuid().nullable(),
        name: z.string().trim().min(1, 'Enter a name for every person.').max(120, 'Names can be up to 120 characters.'),
        email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address for every person.')),
        role: z.enum(['signer', 'approver', 'viewer', 'cc']),
        order: z.number().int().min(1).max(99),
        // the extra identity check; the typed code is hashed below and never stored or logged as typed
        check: z.enum(['link', 'access_code', 'email_otp']).default('link'),
        code: z.string().max(200).default(''),
        // D-81: signers with the same group name share one turn; the first of them to sign completes it
        group: z.string().trim().max(60, 'A signing group name can be up to 60 characters.').default(''),
      }),
    )
    .min(1, 'Add at least one person who signs.')
    .max(MAX_RECIPIENTS, `A document can have up to ${MAX_RECIPIENTS} people.`),
});

/**
 * Save everyone involved in a draft, in list order, together with how they take turns (D-52).
 * For "one after another" and "all at once" the turn numbers are worked out here from the list order;
 * for "custom order" the numbers the sender typed are used.
 */
export async function saveRecipientsAction(envelopeId: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(envelopeId);
  const parsed = recipientsSchema.safeParse(input);
  if (!id.success) return { ok: false, message: 'Document not found.' };
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the list of people.' };
  const { mode, recipients } = parsed.data;

  const orders = mode === 'mixed' ? recipients.map((r) => r.order) : assignOrders(mode, recipients.map((r) => r.role), recipients.map((r) => (r.role === 'signer' ? r.group : null)));
  const verdict = validateRouting(recipients.map((r, i) => ({ id: String(i), role: r.role, order: orders[i], status: 'created' as const, group: r.role === 'signer' ? r.group || null : null })), mode);
  if (!verdict.ok) return { ok: false, message: verdict.message };
  const seen = new Set<string>();
  for (const r of recipients) {
    const key = `${r.email}|${r.role}`;
    if (seen.has(key)) return { ok: false, message: `${r.email} is listed twice with the same role. Remove one of them.` };
    seen.add(key);
  }

  const me = (user.email ?? '').toLowerCase();
  // An extra check makes no sense for someone who only gets a copy, or for the sender signing their own document.
  const wanted = recipients.map((r) => (r.role === 'cc' || r.email === me ? ('link' as const) : r.check));
  const codes: (string | null)[] = [];
  for (const [i, r] of recipients.entries()) {
    if (wanted[i] !== 'access_code' || r.code.trim() === '') {
      codes.push(null);
      continue;
    }
    const code = checkAccessCode(r.code);
    if (!code.ok) return { ok: false, message: `${r.name}: ${code.message}` };
    codes.push(code.value);
  }
  const admin = supabaseAdmin();
  const routing = await admin.rpc('set_routing_mode', { p_actor: user.id, p_envelope_id: id.data, p_mode: mode });
  if (routing.error) return { ok: false, message: friendlyDbError(routing.error.message).message };
  const { data: saved, error } = await admin.rpc('save_recipients', {
    p_actor: user.id,
    p_envelope_id: id.data,
    p_recipients: recipients.map((r, i) => ({ id: r.id, name: r.name, email: r.email, role: r.role, routing_order: orders[i], is_sender: r.email === me, signing_group: r.role === 'signer' ? r.group || null : null })),
  });
  if (error) {
    const friendly = friendlyDbError(error.message);
    return { ok: false, message: /recipients_unique_email/.test(error.message) ? 'The same email address is listed twice with the same role.' : friendly.message };
  }
  // The identity checks, one person at a time. Only what changed is written; a code is hashed here (slowly, on
  // purpose) and only the hash goes to the database.
  const rows = (saved ?? []) as { id: string; email: string; role: string; auth_method: string }[];
  for (const [i, r] of recipients.entries()) {
    const row = rows.find((x) => x.email === r.email && x.role === r.role);
    if (!row) continue;
    if (row.auth_method === wanted[i] && codes[i] === null) continue;
    const auth = await admin.rpc('set_recipient_auth', {
      p_actor: user.id,
      p_envelope_id: id.data,
      p_recipient_id: row.id,
      p_method: wanted[i],
      p_access_code_hash: codes[i] === null ? null : await hashAccessCode(codes[i]!),
    });
    if (auth.error) {
      revalidatePath(`/app/envelopes/${id.data}`);
      return { ok: false, message: `The people were saved, but the extra check for ${r.name} was not: ${friendlyDbError(auth.error.message).message}` };
    }
  }
  revalidatePath(`/app/envelopes/${id.data}`);
  return { ok: true, message: 'Saved.' };
}

/** Autosave from the field editor. The whole layout is sent each time; the database replaces it atomically. */
export async function saveFieldsAction(envelopeId: string, fields: unknown): Promise<ActionResult & { hash?: string }> {
  const user = await requireUser();
  const id = z.uuid().safeParse(envelopeId);
  const parsed = fieldsSchema.safeParse(fields);
  if (!id.success || !parsed.success) return { ok: false, message: 'Those fields could not be saved. Reload the page and try again.' };
  // D-81: the editor shows each signing group once (its first member); every other member gets the same fields
  const userDb = await createSupabaseServerClient();
  const { data: people } = await userDb.from('recipients').select('id, signing_group, routing_order, created_at').eq('envelope_id', id.data);
  const { data, error } = await supabaseAdmin().rpc('save_fields', { p_actor: user.id, p_envelope_id: id.data, p_fields: mirrorGroupFields(parsed.data, people ?? []) });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  return { ok: true, hash: data as string };
}

const EXPIRY_CHOICES = [7, 14, 30, 60] as const;
/** remind choice on the send form -> [first reminder after N days, then every N days, at most N times] */
const REMINDER_CHOICES: Record<string, [number | null, number | null, number]> = { '0': [null, null, 0], '1': [1, 1, 5], '3': [3, 3, 3], '7': [7, 7, 3] };

/**
 * Send the document. delivery "email" queues the request email (written to the dev outbox in log mode);
 * "link" sends nothing and lets the sender share the link themselves (zero email cost).
 */
export async function sendEnvelopeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get('envelope_id'));
  const delivery = z.enum(['email', 'link']).safeParse(formData.get('delivery'));
  if (!id.success || !delivery.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };

  // D-79: formulas and conditions are checked here in full (the database checks only their shape). Read with the
  // user's own session, so nothing is learnt about a document they may not see.
  const userDb = await createSupabaseServerClient();
  const synced = await syncGroupFields(user.id, id.data);
  if (!synced.ok) return synced;
  const { data: fieldRows } = await userDb.from('fields').select('id, type, page, recipient_id, options').eq('envelope_id', id.data).order('page').order('y').order('x');
  const notReady = sendProblems(toLogicFields(fieldRows));
  if (notReady.length) return { ok: false, message: `Not ready to send. ${notReady[0]}${notReady.length > 1 ? ` (and ${notReady.length - 1} more: see the field editor)` : ''}` };

  const admin = supabaseAdmin();
  // The recipient ids are only used to prepare link records; send_envelope itself verifies that this
  // user may send this envelope and that the records match its signers.
  // Everyone except copy-only recipients gets a link record (D-52): signers, approvers and viewers.
  const signers = await admin.from('recipients').select('id').eq('envelope_id', id.data).neq('role', 'cc');
  const tokens = (signers.data ?? []).map((r) => mintTokenRecord(r.id as string));
  const days = Number(formData.get('expires_days') ?? 30);
  const expiryDays = (EXPIRY_CHOICES as readonly number[]).includes(days) ? days : 30;
  const expires = new Date(Date.now() + expiryDays * 24 * 3600 * 1000).toISOString();
  // Reminders are emails, so they are switched off when the sender shares the links personally.
  const [after, every, max] = delivery.data === 'email' ? (REMINDER_CHOICES[String(formData.get('remind') ?? '3')] ?? REMINDER_CHOICES['3']) : REMINDER_CHOICES['0'];
  const reminders = await admin.rpc('set_reminders', { p_actor: user.id, p_envelope_id: id.data, p_after_days: after, p_every_days: every, p_max: max });
  if (reminders.error) return { ok: false, message: friendlyDbError(reminders.error.message).message };
  const delegation = await admin.rpc('set_delegation', { p_actor: user.id, p_envelope_id: id.data, p_allow: formData.get('allow_delegation') === 'on' });
  if (delegation.error) return { ok: false, message: friendlyDbError(delegation.error.message).message };
  const { error } = await admin.rpc('send_envelope', { p_actor: user.id, p_envelope_id: id.data, p_tokens: tokens, p_expires_at: expires, p_delivery: delivery.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${id.data}`);
  return { ok: true, message: delivery.data === 'email' ? 'Sent. The signer will receive an email with their link.' : 'Ready. Copy the signing link below and share it with the signer.' };
}

/**
 * D-81: before sending, make sure every member of each signing group has exactly the first member's fields (people may
 * have joined or left a group after the fields were placed). Writes only when something differs.
 */
async function syncGroupFields(actor: string, envelopeId: string): Promise<ActionResult> {
  const userDb = await createSupabaseServerClient();
  const [{ data: people }, { data: rows }] = await Promise.all([
    userDb.from('recipients').select('id, signing_group, routing_order, created_at').eq('envelope_id', envelopeId),
    userDb.from('fields').select('document_id, recipient_id, type, page, x, y, w, h, required, options').eq('envelope_id', envelopeId),
  ]);
  if (!(people ?? []).some((r) => r.signing_group)) return { ok: true };
  const current = (rows ?? []).map((f) => ({
    document_id: f.document_id as string, recipient_id: f.recipient_id as string, type: f.type as string, page: Number(f.page),
    x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h), required: Boolean(f.required), options: (f.options ?? {}) as Record<string, unknown>,
  }));
  const wanted = mirrorGroupFields(current, people ?? []);
  const canon = (fs: typeof current) => fs.map((f) => JSON.stringify(f)).sort().join('\n');
  if (canon(wanted) === canon(current)) return { ok: true };
  const { error } = await supabaseAdmin().rpc('save_fields', { p_actor: actor, p_envelope_id: envelopeId, p_fields: wanted });
  return error ? { ok: false, message: friendlyDbError(error.message).message } : { ok: true };
}

/** The sender asks for the signing link to share it themselves. Only members of the workspace get it. */
export interface RevealedLink {
  name: string;
  role: string;
  order: number;
  status: string;
  link: string;
}

export async function getSigningLinkAction(envelopeId: string): Promise<{ ok: true; links: RevealedLink[] } | { ok: false; message: string }> {
  const user = await requireUser();
  const id = z.uuid().safeParse(envelopeId);
  if (!id.success) return { ok: false, message: 'Document not found.' };
  // The database function checks that this user is a member (not a viewer, not suspended) of the
  // document's workspace and that the document is open, and writes "link_revealed" to the audit trail.
  const rows = await supabaseAdmin().rpc('reveal_signing_links', { p_actor: user.id, p_envelope_id: id.data });
  if (rows.error) return { ok: false, message: friendlyDbError(rows.error.message).message };
  type Row = { token_id: string; nonce_hex: string; recipient_name: string; recipient_role: string; recipient_order: number; recipient_status: string };
  const links = ((rows.data ?? []) as Row[]).map((t) => ({
    name: t.recipient_name,
    role: t.recipient_role,
    order: t.recipient_order,
    status: t.recipient_status,
    link: signingLink(t.token_id, Buffer.from(t.nonce_hex, 'hex')),
  }));
  return { ok: true, links };
}

/** Cancel (void) a document that has been sent and is not complete. Every link stops working at once. */
export async function voidEnvelopeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get('envelope_id'));
  const reason = z.string().max(1000).safeParse(formData.get('reason') ?? '');
  if (!id.success || !reason.success) return { ok: false, message: 'Keep the reason under 1000 characters.' };
  if (formData.get('confirm') !== 'on') return { ok: false, message: 'Tick the box to confirm that you want to cancel this document for everyone.' };
  const { error } = await supabaseAdmin().rpc('void_envelope', { p_actor: user.id, p_envelope_id: id.data, p_reason: reason.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${id.data}`);
  return { ok: true, message: 'Cancelled.' };
}

/** Email the request again to someone whose turn it is (same link). */
export async function resendRequestAction(envelopeId: string, recipientId: string): Promise<ActionResult> {
  const user = await requireUser();
  const ids = z.object({ e: z.uuid(), r: z.uuid() }).safeParse({ e: envelopeId, r: recipientId });
  if (!ids.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  const { error } = await supabaseAdmin().rpc('resend_request', { p_actor: user.id, p_envelope_id: ids.data.e, p_recipient_id: ids.data.r });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${ids.data.e}`);
  return { ok: true, message: 'Sent again.' };
}

/** Lifts a lock that too many wrong codes put on one person's link. Only a member of the workspace can. */
export async function unlockRecipientAction(envelopeId: string, recipientId: string): Promise<ActionResult> {
  const user = await requireUser();
  const ids = z.object({ e: z.uuid(), r: z.uuid() }).safeParse({ e: envelopeId, r: recipientId });
  if (!ids.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  const { data, error } = await supabaseAdmin().rpc('unlock_recipient_auth', { p_actor: user.id, p_envelope_id: ids.data.e, p_recipient_id: ids.data.r });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${ids.data.e}`);
  return { ok: true, message: data === true ? 'Unlocked. They get five new tries.' : 'Their link was not locked any more.' };
}

const correctionSchema = z.object({
  envelope_id: z.uuid(),
  recipient_id: z.uuid(),
  name: z.string().trim().min(1, 'Enter the person\'s name.').max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address.')),
});

/**
 * Correct a person's name or email after sending, as long as they have not finished. A new link record
 * is always prepared; the database uses it only if the email really changed (the old link is then revoked).
 */
export async function correctRecipientAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = correctionSchema.safeParse({ envelope_id: formData.get('envelope_id'), recipient_id: formData.get('recipient_id'), name: formData.get('name'), email: formData.get('email') });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the name and email address.' };
  const token = mintTokenRecord(parsed.data.recipient_id);
  const { data, error } = await supabaseAdmin().rpc('correct_recipient', {
    p_actor: user.id,
    p_envelope_id: parsed.data.envelope_id,
    p_recipient_id: parsed.data.recipient_id,
    p_name: parsed.data.name,
    p_email: parsed.data.email,
    p_token: { token_id: token.token_id, nonce: token.nonce, token_sha256: token.token_sha256 },
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${parsed.data.envelope_id}`);
  const what = data as string;
  return {
    ok: true,
    message:
      what === 'email_changed'
        ? 'Corrected. The old link no longer works and a new one has been issued for the new address. Anything the old address had started was cleared.'
        : what === 'name_changed'
          ? 'Name corrected. Their link is unchanged.'
          : 'Nothing was changed.',
  };
}

/**
 * D-83 (AT4.6): give an unfinished signer's or approver's part to a different person. The old link stops working at
 * once, a fresh one is issued, what the old person started is cleared, and the handoff is recorded with the reason.
 */
const reassignSchema = z.object({
  envelope_id: z.uuid(),
  recipient_id: z.uuid(),
  name: z.string().trim().min(1, 'Enter the new person’s name.').max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address.')),
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').default(''),
});
export async function reassignRecipientAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = reassignSchema.safeParse({
    envelope_id: formData.get('envelope_id'), recipient_id: formData.get('recipient_id'), name: formData.get('name'), email: formData.get('email'), reason: formData.get('reason') ?? '',
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the name and email address.' };
  const token = mintTokenRecord(parsed.data.recipient_id);
  const { error } = await supabaseAdmin().rpc('reassign_recipient', {
    p_actor: user.id,
    p_envelope_id: parsed.data.envelope_id,
    p_recipient_id: parsed.data.recipient_id,
    p_name: parsed.data.name,
    p_email: parsed.data.email,
    p_reason: parsed.data.reason,
    p_token: { token_id: token.token_id, nonce: token.nonce, token_sha256: token.token_sha256 },
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${parsed.data.envelope_id}`);
  return { ok: true, message: `Reassigned to ${parsed.data.name}. The old link no longer works; a new one was issued. Anything the previous person had started was cleared.` };
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get('envelope_id'));
  if (!id.success) redirect('/app');
  const { data, error } = await supabaseAdmin().rpc('delete_draft_envelope', { p_actor: user.id, p_envelope_id: id.data });
  if (!error) {
    // The database row is gone; now remove the stored file so it stops counting against storage.
    for (const row of (data ?? []) as { storage_backend: Backend; storage_path: string }[]) {
      await getStorageFor(row.storage_backend).remove('originals', row.storage_path, { draftOnly: true }).catch(() => {});
    }
  }
  redirect('/app');
}

/** Marks a signer's request (a paper copy, or a withdrawn consent) as dealt with (Phase 3, AT3.3). */
export async function completeTaskAction(envelopeId: string, taskId: string): Promise<ActionResult> {
  const user = await requireUser();
  const ids = z.object({ e: z.uuid(), t: z.uuid() }).safeParse({ e: envelopeId, t: taskId });
  if (!ids.success) return { ok: false, message: 'That request was not understood. Reload the page and try again.' };
  const { error } = await supabaseAdmin().rpc('complete_sender_task', { p_actor: user.id, p_task_id: ids.data.t });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/envelopes/${ids.data.e}`);
  return { ok: true, message: 'Marked as done.' };
}
