import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashPin, pinProblem, verifyPin, IDLE_LOCK_SECONDS, IDLE_WARNING_SECONDS, HEARTBEAT_SECONDS } from './in-person';

describe('in-person signing PIN (D-86)', () => {
  it('accepts 4 to 8 digits that are not trivially guessable', () => {
    expect(pinProblem('4071')).toBeNull();
    expect(pinProblem('90817263')).toBeNull();
    expect(pinProblem('123')).toMatch(/4 to 8 digits/);
    expect(pinProblem('123456789')).toMatch(/4 to 8 digits/);
    expect(pinProblem('12a4')).toMatch(/4 to 8 digits/);
    expect(pinProblem('7777')).toMatch(/repeated/);
    expect(pinProblem('1234')).toMatch(/run of digits/);
    expect(pinProblem('8765')).toMatch(/run of digits/);
    expect(pinProblem('4071', '4072')).toMatch(/not the same/);
    expect(pinProblem('4071', '4071')).toBeNull();
  });

  it('a stored PIN matches only itself, and every hash is different (fresh salt)', () => {
    const h = hashPin('4071');
    expect(h).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(hashPin('4071')).not.toBe(h);
    expect(verifyPin('4071', h)).toBe(true);
    expect(verifyPin('4072', h)).toBe(false);
    expect(verifyPin('', h)).toBe(false);
    expect(verifyPin('4071', 'scrypt$nothex$nothex')).toBe(false);
    expect(verifyPin('4071', '')).toBe(false);
  });

  it('never throws, whatever it is given', () => {
    const h = hashPin('5820');
    fc.assert(
      fc.property(fc.string(), fc.string(), (pin, stored) => {
        expect(typeof verifyPin(pin, stored)).toBe('boolean');
        expect(verifyPin(pin, h)).toBe(pin === '5820');
      }),
      { numRuns: 60 },
    );
  });

  it('warns before locking, and tells the server often enough that it never locks someone who is busy', () => {
    expect(IDLE_WARNING_SECONDS).toBeLessThan(IDLE_LOCK_SECONDS);
    // the server locks after 300 quiet seconds; a busy screen reports at least once a minute
    expect(HEARTBEAT_SECONDS).toBeLessThan(300 - IDLE_LOCK_SECONDS);
  });
});
