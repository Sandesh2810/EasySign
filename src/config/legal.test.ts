import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONSENT_PARAGRAPHS, CONSENT_SHA256, CONSENT_TEXT, CONSENT_VERSION, EXCLUDED_DOCUMENTS } from './legal';

describe('consent wording (AT3.3)', () => {
  it('the wording matches its pinned fingerprint: change the words only together with a new version', () => {
    expect(createHash('sha256').update(CONSENT_TEXT, 'utf8').digest('hex')).toBe(CONSENT_SHA256);
  });

  it('the version name is one the database accepts', () => {
    expect(CONSENT_VERSION).toMatch(/^[a-z0-9][a-z0-9.-]{1,63}$/);
  });

  it('tells the signer how to ask for paper and how to withdraw, using the labels on the page', () => {
    expect(CONSENT_TEXT).toContain('"Ask for a paper copy"');
    expect(CONSENT_TEXT).toContain('"Withdraw consent"');
    expect(CONSENT_PARAGRAPHS.length).toBeGreaterThanOrEqual(5);
    expect(CONSENT_TEXT.length).toBeLessThan(20000);
  });

  it('lists the documents that should not be sent', () => {
    expect(EXCLUDED_DOCUMENTS.some((d) => d.startsWith('wills'))).toBe(true);
    expect(EXCLUDED_DOCUMENTS.length).toBeGreaterThanOrEqual(8);
  });
});
