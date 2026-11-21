'use server';
// Bulk send (Phase 4 slice 9, AT4.2, D-85). The browser sends the rows it read from the CSV; the database checks every
// row again (create_bulk_batch) and the worker sends them over time. Cancelling stops what has not been sent.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/request-guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getStorageFor } from '@/storage';
import type { Backend } from '@/storage/types';

export type BulkResult = { ok: true; message?: string } | { ok: false; message: string };

const rowsSchema = z
  .array(
    z.object({
      rowNo: z.number().int().min(1).max(500),
      name: z.string().max(300),
      email: z.string().max(300),
      values: z.record(z.string().max(60), z.string().max(1000)),
    }),
  )
  .min(1, 'The file has no rows.')
  .max(500, 'Up to 500 rows per batch.');

export async function createBulkAction(input: { templateId: string; delivery: string; expiresDays: number; rows: unknown }): Promise<BulkResult> {
  const user = await requireUser();
  const templateId = z.uuid().safeParse(input.templateId);
  const delivery = z.enum(['email', 'link']).safeParse(input.delivery);
  const days = z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]).safeParse(input.expiresDays);
  const rows = rowsSchema.safeParse(input.rows);
  if (!templateId.success || !delivery.success || !days.success) return { ok: false, message: 'That request was not understood. Reload the page.' };
  if (!rows.success) return { ok: false, message: rows.error.issues[0]?.message ?? 'Check the file.' };
  const { data, error } = await supabaseAdmin().rpc('create_bulk_batch', {
    p_actor: user.id,
    p_template_id: templateId.data,
    p_delivery: delivery.data,
    p_expires_days: days.data,
    p_rows: rows.data.map((r) => ({ row_no: r.rowNo, name: r.name, email: r.email, values: r.values })),
  });
  if (error || !data) return { ok: false, message: friendlyDbError(error?.message).message };
  revalidatePath('/app/templates');
  redirect(`/app/bulk/${data as string}`);
}

export async function cancelBulkAction(batchId: string): Promise<BulkResult> {
  const user = await requireUser();
  const id = z.uuid().safeParse(batchId);
  if (!id.success) return { ok: false, message: 'Batch not found.' };
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('cancel_bulk_batch', { p_actor: user.id, p_batch_id: id.data });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  // drafts made for rows that never went out are removed, files included
  for (const envelopeId of (data ?? []) as string[]) {
    const del = await admin.rpc('delete_draft_envelope', { p_actor: user.id, p_envelope_id: envelopeId });
    for (const row of (del.data ?? []) as { storage_backend: Backend; storage_path: string }[]) {
      await getStorageFor(row.storage_backend).remove('originals', row.storage_path, { draftOnly: true }).catch(() => {});
    }
  }
  revalidatePath(`/app/bulk/${id.data}`);
  return { ok: true, message: 'Cancelled. Nothing more will be sent from this batch.' };
}
