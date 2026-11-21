'use server';
// D-87: public forms (PowerForms) on a one-person template: create, pause, resume.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { friendlyDbError } from '@/lib/db-error';
import { newFormSlug } from '@/lib/power-form';
import { supabaseAdmin } from '@/lib/supabase/admin';

type Result = { ok: true; message: string } | { ok: false; message: string };

const createInput = z.object({
  templateId: z.uuid(),
  title: z.string().trim().min(1, 'Give the form a title.').max(120, 'The title can be up to 120 characters.'),
  dailyLimit: z.number().int().min(1, 'The daily limit must be at least 1.').max(500, 'The daily limit can be up to 500.'),
  emailCheck: z.boolean(),
});

export async function createPowerFormAction(raw: { templateId: string; title: string; dailyLimit: number; emailCheck: boolean }): Promise<Result> {
  const parsed = createInput.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form details.' };
  const user = await requireUser(`/app/templates/${parsed.data.templateId}`);
  const { error } = await supabaseAdmin().rpc('create_power_form', {
    p_actor: user.id,
    p_template_id: parsed.data.templateId,
    p_title: parsed.data.title,
    p_daily_limit: parsed.data.dailyLimit,
    p_email_check: parsed.data.emailCheck,
    p_slug: newFormSlug(),
  });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/templates/${parsed.data.templateId}`);
  return { ok: true, message: 'The public form is ready. Copy its link below.' };
}

export async function setPowerFormStatusAction(raw: { templateId: string; formId: string; active: boolean }): Promise<Result> {
  const parsed = z.object({ templateId: z.uuid(), formId: z.uuid(), active: z.boolean() }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'Form not found.' };
  const user = await requireUser(`/app/templates/${parsed.data.templateId}`);
  const { error } = await supabaseAdmin().rpc('set_power_form_status', { p_actor: user.id, p_form_id: parsed.data.formId, p_status: parsed.data.active ? 'active' : 'paused' });
  if (error) return { ok: false, message: friendlyDbError(error.message).message };
  revalidatePath(`/app/templates/${parsed.data.templateId}`);
  return { ok: true, message: parsed.data.active ? 'The form takes submissions again.' : 'Paused. The link shows "not available" until you resume it.' };
}
