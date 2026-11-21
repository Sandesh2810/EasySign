// D-97: the load test's arithmetic and its safety rule.
import { describe, expect, it } from 'vitest';
import { isLocalTarget, spread, stats } from './load-stats';

describe('load test arithmetic', () => {
  it('percentiles by nearest rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(stats(xs)).toEqual({ n: 100, p50: 50, p95: 95, max: 100, mean: 51 });
    expect(stats([7])).toEqual({ n: 1, p50: 7, p95: 7, max: 7, mean: 7 });
    expect(stats([])).toEqual({ n: 0, p50: null, p95: null, max: null, mean: null });
    expect(stats([3, Number.NaN, 1, 2]).n).toBe(3);
  });
  it('spreads people over documents evenly', () => {
    const s = spread(100, 30);
    expect(s.reduce((a, b) => a + b, 0)).toBe(100);
    expect(s.filter((n) => n === 4)).toHaveLength(10);
    expect(s.filter((n) => n === 3)).toHaveLength(20);
    expect(spread(5, 10)).toEqual([1, 1, 1, 1, 1]);
  });
  it('only this PC may be load-tested without an approval', () => {
    expect(isLocalTarget('http://localhost:3000')).toBe(true);
    expect(isLocalTarget('http://127.0.0.1:3100/')).toBe(true);
    expect(isLocalTarget('https://younmesign.com')).toBe(false);
    expect(isLocalTarget('http://localhost.example.com')).toBe(false);
    expect(isLocalTarget('http://10.0.0.5:3000')).toBe(false);
  });
});
