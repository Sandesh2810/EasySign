import { describe, it, expect } from 'vitest';
import { checkSend, checkUpload, level, trustUpgradeEligible, type AccountState } from './quota';

const restricted: AccountState = {
  trust: 'restricted',
  approved: true,
  envelopesToday: 0,
  externalRecipientsToday: 0,
  caps: { envelopesPerDay: 3, externalRecipientsPerDay: 5 },
};

describe('send quota', () => {
  it('allows a normal send for a restricted account within caps', () => {
    expect(checkSend(restricted, { newExternalRecipients: 2, registrationMode: 'open' })).toEqual({ ok: true });
  });
  it('blocks the 4th envelope of the day for a restricted account', () => {
    const r = checkSend({ ...restricted, envelopesToday: 3 }, { newExternalRecipients: 1, registrationMode: 'open' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ENVELOPE_CAP');
  });
  it('blocks when distinct external recipients would exceed 5', () => {
    const r = checkSend({ ...restricted, externalRecipientsToday: 4 }, { newExternalRecipients: 2, registrationMode: 'open' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RECIPIENT_CAP');
  });
  it('trusted accounts are not capped by the new-account limits', () => {
    expect(checkSend({ ...restricted, trust: 'trusted', envelopesToday: 50, externalRecipientsToday: 80 }, { newExternalRecipients: 9, registrationMode: 'open' }).ok).toBe(true);
  });
  it('suspended accounts cannot send', () => {
    const r = checkSend({ ...restricted, trust: 'suspended' }, { newExternalRecipients: 0, registrationMode: 'open' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SUSPENDED');
  });
  it('approval mode holds unapproved accounts, but self-signing with no external recipient is still allowed', () => {
    const pending = { ...restricted, approved: false };
    const r = checkSend(pending, { newExternalRecipients: 1, registrationMode: 'approval' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PENDING_APPROVAL');
    expect(checkSend(pending, { newExternalRecipients: 0, registrationMode: 'approval' }).ok).toBe(true);
    expect(checkSend(pending, { newExternalRecipients: 1, registrationMode: 'open' }).ok).toBe(true);
  });
});

describe('upload quota', () => {
  const base = { sizeBytes: 1_000_000, pages: 5, userUsedBytes: 0, userQuotaBytes: 50 * 1024 * 1024, platformStorageUsedPct: 10 };
  it('accepts a small file', () => expect(checkUpload(base)).toEqual({ ok: true }));
  it('rejects over 10 MB', () => {
    const r = checkUpload({ ...base, sizeBytes: 10 * 1024 * 1024 + 1 });
    expect(!r.ok && r.code).toBe('FILE_TOO_LARGE');
  });
  it('rejects over 100 pages', () => {
    const r = checkUpload({ ...base, pages: 101 });
    expect(!r.ok && r.code).toBe('TOO_MANY_PAGES');
  });
  it('rejects when the user quota would be exceeded', () => {
    const r = checkUpload({ ...base, userUsedBytes: 50 * 1024 * 1024 - 10 });
    expect(!r.ok && r.code).toBe('USER_QUOTA');
  });
  it('blocks uploads gracefully when the platform is at 90% storage', () => {
    const r = checkUpload({ ...base, platformStorageUsedPct: 90 });
    expect(!r.ok && r.code).toBe('PLATFORM_FULL');
    expect(checkUpload({ ...base, platformStorageUsedPct: 89.9 }).ok).toBe(true);
  });
});

describe('thresholds', () => {
  it('ok below 70, warn from 70, block from 90', () => {
    expect(level(0)).toBe('ok');
    expect(level(69.9)).toBe('ok');
    expect(level(70)).toBe('warn');
    expect(level(89.9)).toBe('warn');
    expect(level(90)).toBe('block');
    expect(level(140)).toBe('block');
  });
});

describe('trust upgrade (D-30)', () => {
  const good = { completedWithExternalRecipient: 1, accountAgeDays: 7, openAbuseReports: 0, adminTrusted: false };
  it('needs an external-recipient completion, 7 days of age and no open abuse report', () => {
    expect(trustUpgradeEligible(good)).toBe(true);
    expect(trustUpgradeEligible({ ...good, completedWithExternalRecipient: 0 })).toBe(false); // self-sign only
    expect(trustUpgradeEligible({ ...good, accountAgeDays: 6.9 })).toBe(false);
    expect(trustUpgradeEligible({ ...good, openAbuseReports: 1 })).toBe(false);
  });
  it('an admin flag overrides', () => {
    expect(trustUpgradeEligible({ completedWithExternalRecipient: 0, accountAgeDays: 0, openAbuseReports: 0, adminTrusted: true })).toBe(true);
  });
});
