// When a finished document may be deleted (Phase 3 slice 6, D-71). The database decides again
// (app_private.retained_until); this is only for showing the date and whether the Delete form appears.

export interface RetentionView {
  keepUntil: Date;
  mayDeleteNow: boolean;
}

/** finishedAt: completion, expiry or the last change of a finished document; years: the workspace period. */
export function retentionWindow(finishedAt: string | Date, years: number, nowMs: number = Date.now()): RetentionView {
  const keepUntil = new Date(finishedAt);
  keepUntil.setUTCFullYear(keepUntil.getUTCFullYear() + Math.max(0, Math.trunc(years)));
  return { keepUntil, mayDeleteNow: keepUntil.getTime() <= nowMs };
}
