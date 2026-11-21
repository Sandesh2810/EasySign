'use server';
// D-92: webhook endpoints. Owners and administrators only (the database checks again). A signing secret is returned
// once, here, and stored only encrypted.
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/db-error';
import { env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';
import { sealSecret } from '@/lib/webhooks/secret-box';
import { newWebhookSecret } from '@/lib/webhooks/signature';
import { checkWebhookUrl, loopbackAllowed } from '@/lib/webhooks/url-guard';

type Result = { ok: true; message: string } | { ok: false; message: string };
const PATH = '/app/settings/webhooks';
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event.');
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export async function createWebhookAction(raw: { orgId: string; url: string; description: string; events: string[] }): Promise<{ ok: true; secret: string } | { ok: false; message: string }> {
  const parsed = z.object({ orgId: z.uuid(), url: z.string().max(2000), description: z.string().trim().max(200, 'Keep the description to 200 characters.'), events }).safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the details.');
  const url = checkWebhookUrl(parsed.data.url, { allowLoopback: loopbackAllowed(process.env) });
  if (!url.ok) return fail(url.reason);
  const user = await requireUser(PATH);
  const id = randomUUID();
  const secret = newWebhookSecret();
  const { error } = await supabaseAdmin().rpc('webhook_endpoint_create', {
    p_actor: user.id,
    p_org: parsed.data.orgId,
    p_id: id,
    p_url: url.url.toString(),
    p_description: parsed.data.description,
    p_events: parsed.data.events,
    p_secret_enc: sealSecret(secret, id, env.storageKey()),
  });
  if (error) return fail(friendlyDbError(error.message).message);
  revalidatePath(PATH);
  return { ok: true, secret };
}

export async function updateWebhookAction(raw: { id: string; enabled?: boolean; events?: string[]; description?: string }): Promise<Result> {
  const parsed = z.object({ id: z.uuid(), enabled: z.boolean().optional(), events: events.optional(), description: z.string().trim().max(200, 'Keep the description to 200 characters.').optional() }).safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the details.');
  const user = await requireUser(PATH);
  const { error } = await supabaseAdmin().rpc('webhook_endpoint_update', {
    p_actor: user.id,
    p_id: parsed.data.id,
    p_events: parsed.data.events ?? null,
    p_enabled: parsed.data.enabled ?? null,
    p_description: parsed.data.description ?? null,
  });
  if (error) return fail(friendlyDbError(error.message).message);
  revalidatePath(PATH);
  return { ok: true, message: parsed.data.enabled === true ? 'Switched on.' : parsed.data.enabled === false ? 'Switched off. Nothing more is sent until you switch it on.' : 'Saved.' };
}

export async function rotateWebhookSecretAction(id: string): Promise<{ ok: true; secret: string } | { ok: false; message: string }> {
  if (!z.uuid().safeParse(id).success) return fail('Endpoint not found.');
  const user = await requireUser(PATH);
  const secret = newWebhookSecret();
  const { error } = await supabaseAdmin().rpc('webhook_endpoint_rotate', { p_actor: user.id, p_id: id, p_secret_enc: sealSecret(secret, id, env.storageKey()) });
  if (error) return fail(friendlyDbError(error.message).message);
  revalidatePath(PATH);
  return { ok: true, secret };
}

export async function deleteWebhookAction(id: string): Promise<Result> {
  if (!z.uuid().safeParse(id).success) return fail('Endpoint not found.');
  const user = await requireUser(PATH);
  const { error } = await supabaseAdmin().rpc('webhook_endpoint_delete', { p_actor: user.id, p_id: id });
  if (error) return fail(friendlyDbError(error.message).message);
  revalidatePath(PATH);
  return { ok: true, message: 'Deleted, with its delivery log.' };
}

export async function testWebhookAction(id: string): Promise<Result> {
  if (!z.uuid().safeParse(id).success) return fail('Endpoint not found.');
  const user = await requireUser(PATH);
  const { error } = await supabaseAdmin().rpc('webhook_test', { p_actor: user.id, p_id: id });
  if (error) return fail(friendlyDbError(error.message).message);
  revalidatePath(PATH);
  return { ok: true, message: 'Test event queued. It is sent within a few seconds; refresh the delivery log to see the result.' };
}

export async function redeliverWebhookAction(deliveryId: string): Promise<Result> {
  if (!z.uuid().safeParse(deliveryId).success) return fail('Delivery not found.');
  const user = await requireUser(PATH);
  const { error } = await supabaseAdmin().rpc('webhook_redeliver', { p_actor: user.id, p_delivery: deliveryId });
  if (error) return fail(friendlyDbError(error.message).message);
  revalidatePath(PATH);
  return { ok: true, message: 'Queued to be sent once more.' };
}
