import { describe, it, expect } from 'vitest';
import { codeForLookup, parseVerifyResponse, sameSha256 } from './verify-result';
import { generatePublicCode } from './public-code';

const H = (c: string) => c.repeat(64);

describe('verify-result (AT3.2)', () => {
  it('tidies a typed code; anything else goes to the database as typed, capped, so it is rate limited the same way', () => {
    const code = generatePublicCode(new Date('2026-11-19T00:00:00Z'));
    expect(codeForLookup(`  ${code.toLowerCase().replace(/-/g, ' ')} `)).toBe(code);
    expect(codeForLookup('hello')).toBe('hello');
    expect(codeForLookup('x'.repeat(500))).toHaveLength(64);
    expect(codeForLookup('')).toBe('');
    expect(codeForLookup(undefined)).toBe('');
  });

  it('reads a completed answer and keeps only the expected fields', () => {
    const r = parseVerifyResponse({
      found: true, code: 'ES-2611-8GV8-SHRM-65F0-QG', status: 'completed', completed_at: '2026-11-19T18:32:05.893145+00:00',
      signer_count: 2, final_sha256: H('a'), preseal_sha256: H('b'), seal_key_id: H('c'), title: 'should be ignored', email: 'x@example.test',
    });
    expect(r).toEqual({
      kind: 'found', code: 'ES-2611-8GV8-SHRM-65F0-QG', status: 'completed', completedAt: new Date('2026-11-19T18:32:05.893Z'),
      signerCount: 2, finalSha256: H('a'), presealSha256: H('b'), sealKeyId: H('c'),
    });
  });

  it('shows no hashes or completion time for a document that is not completed, even if the answer had them', () => {
    const r = parseVerifyResponse({ found: true, code: 'ES-X', status: 'in_progress', completed_at: '2026-11-19T00:00:00Z', signer_count: 1, final_sha256: H('a') });
    expect(r).toMatchObject({ kind: 'found', status: 'in_progress', completedAt: null, signerCount: null, finalSha256: null, presealSha256: null, sealKeyId: null });
  });

  it('treats anything unexpected as "not found", and "limited" as limited', () => {
    expect(parseVerifyResponse({ limited: true })).toEqual({ kind: 'limited' });
    for (const bad of [null, undefined, 'found', [], {}, { found: false }, { found: true }, { found: true, code: 'X', status: 'hacked' }, { found: 'true', code: 'X', status: 'completed' }]) {
      expect(parseVerifyResponse(bad)).toEqual({ kind: 'not_found' });
    }
    expect(parseVerifyResponse({ found: true, code: 'X', status: 'completed', final_sha256: 'not-hex' })).toMatchObject({ finalSha256: null });
  });

  it('compares hashes exactly (case aside), and never matches an empty or malformed value', () => {
    expect(sameSha256(H('a'), H('A'))).toBe(true);
    expect(sameSha256(H('a'), H('b'))).toBe(false);
    expect(sameSha256('', '')).toBe(false);
    expect(sameSha256('abc', 'abc')).toBe(false);
    expect(sameSha256(null, H('a'))).toBe(false);
  });
});
