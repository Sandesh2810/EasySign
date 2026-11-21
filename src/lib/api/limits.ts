// D-90/D-94: the API's rate limit. The limit itself comes from the workspace's plan (public.plans); this is the free
// plan's value, used by the documentation and as the fallback (a unit test checks it matches the plans migration). Pure.
export const API_RATE = { limit: 60, windowSeconds: 60 } as const;

/** Seconds until the next UTC month starts (when a monthly API limit resets). */
export function secondsToNextMonth(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
