import { describe, it, expect } from 'vitest';
import { bearerKey, keySha256, newApiKey, requestSha256, retryAfterSeconds } from './keys';

describe('API keys (D-90)', () => {
  it('a new key is 48 characters, starts "ynms_", and only its prefix and fingerprint are kept', () => {
    const k = newApiKey();
    expect(k.key).toMatch(/^ynms_[A-Za-z0-9_-]{43}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
    expect(k.sha256).toBe(keySha256(k.key));
    expect(k.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(newApiKey().key).not.toBe(k.key);
  });

  it('reads the key only from a well-formed Bearer header', () => {
    const { key } = newApiKey();
    expect(bearerKey(`Bearer ${key}`)).toBe(key);
    expect(bearerKey(`bearer ${key}`)).toBeNull();
    expect(bearerKey(key)).toBeNull();
    expect(bearerKey(`Bearer ${key}x`)).toBeNull();
    expect(bearerKey(null)).toBeNull();
  });

  it('says how long until the rate-limit window starts again', () => {
    expect(retryAfterSeconds(60, 120_000)).toBe(60);
    expect(retryAfterSeconds(60, 150_500)).toBe(30);
    expect(retryAfterSeconds(60, 179_999)).toBe(1);
  });

  it('identifies a write by method, path and exact body', () => {
    expect(requestSha256('POST', '/a', '{}')).toBe(requestSha256('POST', '/a', '{}'));
    expect(requestSha256('POST', '/a', '{}')).not.toBe(requestSha256('POST', '/b', '{}'));
    expect(requestSha256('POST', '/a', '{}')).not.toBe(requestSha256('POST', '/a', '{ }'));
  });
});
