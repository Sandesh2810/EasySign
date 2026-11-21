// D-90/D-94: the API's rate limit. The limit itself comes from the workspace's plan (public.plans); this is the free
// plan's value, used by the documentation and as the fallback (a unit test checks it matches the plans migration). Pure.
export const API_RATE = { limit: 60, windowSeconds: 60 } as const;

// D-98: drafts made through the API, per person per day (a draft costs storage even if never sent; sending has its own
// daily limits), and downloads of signed copies, per key per hour (each one reads a file from storage).
export const API_CREATE_DAILY = { bucket: 'api_create_user', limit: 200, windowSeconds: 86400 } as const;
export const API_DOWNLOAD_HOURLY = { bucket: 'api_download', limit: 120, windowSeconds: 3600 } as const;

/** Seconds until the next UTC month starts (when a monthly API limit resets). */
export function secondsToNextMonth(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
