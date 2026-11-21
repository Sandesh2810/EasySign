// D-92: the events a webhook endpoint can choose, and the retry rule. Pure: no I/O.
// The retry schedule is enforced by the database (public.webhook_result); this copy is for people and docs, and
// supabase/tests/phase5_slice3_webhooks.sql checks the two agree.

export const WEBHOOK_EVENTS = ['document.sent', 'document.completed', 'document.declined', 'document.voided', 'document.expired', 'person.completed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** The event sent by "Send a test event"; never chosen, always allowed. */
export const TEST_EVENT = 'webhook.test' as const;

export const EVENT_LABELS: Record<WebhookEvent, string> = {
  'document.sent': 'A document was sent',
  'document.completed': 'A document was completed and sealed (the signed PDF can be downloaded)',
  'document.declined': 'A document was declined',
  'document.voided': 'A document was voided',
  'document.expired': 'A document expired',
  'person.completed': 'A person signed or approved',
};

/** Seconds to wait before attempts 2, 3, … 7 (about 21 hours in all). After the seventh failure the delivery stops. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600, 43200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** After this many deliveries in a row fail completely, the endpoint is switched off. */
export const DISABLE_AFTER_FAILED_DELIVERIES = 5;
/** Receivers should refuse a request whose webhook-timestamp is further than this from their clock. */
export const REPLAY_WINDOW_SECONDS = 300;
// how many endpoints a workspace may have is set by its plan (public.plans, D-94)
