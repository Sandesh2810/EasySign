// D-94: the month's usage and the plan's limits, as people read them on Settings. The numbers come from
// public.usage_summary. Pure: no I/O.

export interface PlanLimits {
  id: string;
  name: string;
  max_api_keys: number;
  max_webhook_endpoints: number;
  api_requests_per_minute: number;
  monthly_api_calls: number | null;
}
export interface Usage {
  month: string;
  plan: PlanLimits;
  documents_sent: number;
  people_sent_to: number;
  api_calls: number;
  storage_bytes: number;
  members: number;
  api_keys: number;
  webhook_endpoints: number;
}

/** 0 bytes, 980 bytes, 12.3 KB, 13.5 MB, 1.02 GB (1 KB = 1,000 bytes, as the Supabase quota pages count). */
export function bytesInWords(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n || 0))} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '')} ${units[i]}`;
}

/** "3 of 10", or "1,204 (no limit)". */
export function ofLimit(used: number, limit: number | null): string {
  const f = (x: number) => x.toLocaleString('en-US');
  return limit === null ? `${f(used)} (no limit)` : `${f(used)} of ${f(limit)}`;
}

/** "November 2026" for "2026-11". */
export function monthInWords(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The lines shown on Settings, in order. */
export function usageLines(u: Usage): { label: string; value: string }[] {
  return [
    { label: 'Documents sent', value: u.documents_sent.toLocaleString('en-US') },
    { label: 'People sent to', value: u.people_sent_to.toLocaleString('en-US') },
    { label: 'API requests', value: ofLimit(u.api_calls, u.plan.monthly_api_calls) },
    { label: 'Storage in use now', value: bytesInWords(u.storage_bytes) },
    { label: 'Active members', value: u.members.toLocaleString('en-US') },
    { label: 'API keys', value: ofLimit(u.api_keys, u.plan.max_api_keys) },
    { label: 'Webhook endpoints', value: ofLimit(u.webhook_endpoints, u.plan.max_webhook_endpoints) },
    { label: 'API requests a minute, per key', value: `up to ${u.plan.api_requests_per_minute}` },
  ];
}
