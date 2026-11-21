// `npm run outbox:preview -- <outbox row id>`: shows exactly what the worker would send for one queued or held email
// (to, subject, text, and with --json also the HTML), built from the live data by the same code the worker uses. It
// sends nothing, changes nothing and uses none of the daily email allowance. Useful to check an email that is held
// until the daily reset.
import { supabaseAdmin } from '@/lib/supabase/admin';
import { prepare } from './outbox';
import type { OutboxRow } from './dispatch';

export async function previewOutboxRow(id: string): Promise<{ to: string; subject: string; text: string; html: string }> {
  const { data, error } = await supabaseAdmin().from('notification_outbox').select('*').eq('id', id).maybeSingle();
  if (error || !data) throw new Error('outbox row not found');
  const p = await prepare(data as unknown as OutboxRow);
  return { to: p.to, subject: p.email.subject, text: p.email.text, html: p.email.html };
}
