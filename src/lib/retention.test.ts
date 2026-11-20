import { describe, expect, it } from 'vitest';
import { retentionWindow } from './retention';

describe('retention window (AT3.6)', () => {
  const finished = '2026-11-20T10:00:00Z';
  it('keeps a document for the workspace period, counted from when it was finished', () => {
    const v = retentionWindow(finished, 7, Date.parse('2030-01-01T00:00:00Z'));
    expect(v.keepUntil.toISOString()).toBe('2033-11-20T10:00:00.000Z');
    expect(v.mayDeleteNow).toBe(false);
    expect(retentionWindow(finished, 7, Date.parse('2033-11-20T10:00:00Z')).mayDeleteNow).toBe(true);
  });
  it('no minimum (0 years) allows deletion straight away; nonsense never shortens the period below 0', () => {
    expect(retentionWindow(finished, 0, Date.parse(finished)).mayDeleteNow).toBe(true);
    expect(retentionWindow(finished, -3, Date.parse(finished)).keepUntil.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });
});
