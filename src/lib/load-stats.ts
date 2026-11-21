// D-97: arithmetic for the load test (scripts/load-test.mjs). Pure.

export interface Stats {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
}

/** Nearest-rank percentiles of a list of times in milliseconds, rounded; non-numbers are ignored. */
export function stats(xs: number[]): Stats {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, p50: null, p95: null, max: null, mean: null };
  const at = (q: number) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  return { n: v.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(v[v.length - 1]), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
}

/** People per document, as even as possible (100 over 30: ten documents of 4 and twenty of 3). */
export function spread(people: number, docs: number): number[] {
  const base = Math.floor(people / docs);
  return Array.from({ length: docs }, (_, i) => base + (i < people % docs ? 1 : 0)).filter((n) => n > 0);
}

/** Only this PC may be load-tested without a recorded approval (the server is shared with another app). */
export function isLocalTarget(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url);
}
