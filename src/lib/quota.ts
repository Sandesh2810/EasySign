// Quota and trust rules: pure logic. The database enforces the same rules in send_envelope;
// this module drives the UI messages and is unit-tested. (DECISIONS D-15, D-30; brief: registration controls.)
import { LIMITS, type RegistrationMode } from '@/config/brand';

export type Trust = 'restricted' | 'trusted' | 'suspended';

export interface AccountState {
  trust: Trust;
  /** False while an account waits for admin approval. */
  approved: boolean;
  envelopesToday: number;
  externalRecipientsToday: number;
  caps: { envelopesPerDay: number; externalRecipientsPerDay: number };
}

export type Verdict<C extends string> = { ok: true } | { ok: false; code: C; message: string };

export type SendCode = 'SUSPENDED' | 'PENDING_APPROVAL' | 'ENVELOPE_CAP' | 'RECIPIENT_CAP';

export function checkSend(
  account: AccountState,
  req: { newExternalRecipients: number; registrationMode: RegistrationMode },
): Verdict<SendCode> {
  if (account.trust === 'suspended') {
    return { ok: false, code: 'SUSPENDED', message: 'This account is suspended and cannot send documents.' };
  }
  if (req.registrationMode !== 'open' && !account.approved && req.newExternalRecipients > 0) {
    return { ok: false, code: 'PENDING_APPROVAL', message: 'Your account is waiting for approval. You can sign documents yourself now; sending to others unlocks once approved.' };
  }
  if (account.trust === 'restricted') {
    if (account.envelopesToday >= account.caps.envelopesPerDay) {
      return { ok: false, code: 'ENVELOPE_CAP', message: `New accounts can send ${account.caps.envelopesPerDay} documents a day. Try again tomorrow.` };
    }
    if (account.externalRecipientsToday + req.newExternalRecipients > account.caps.externalRecipientsPerDay) {
      return { ok: false, code: 'RECIPIENT_CAP', message: `New accounts can send to ${account.caps.externalRecipientsPerDay} different people a day. Remove a recipient or try again tomorrow.` };
    }
  }
  return { ok: true };
}

export type UploadCode = 'FILE_TOO_LARGE' | 'TOO_MANY_PAGES' | 'USER_QUOTA' | 'PLATFORM_FULL';

export function checkUpload(u: {
  sizeBytes: number;
  pages: number;
  userUsedBytes: number;
  userQuotaBytes: number;
  platformStorageUsedPct: number;
}): Verdict<UploadCode> {
  const mb = (b: number) => Math.round(b / (1024 * 1024));
  if (u.sizeBytes > LIMITS.maxDocumentBytes) {
    return { ok: false, code: 'FILE_TOO_LARGE', message: `Files can be up to ${mb(LIMITS.maxDocumentBytes)} MB.` };
  }
  if (u.pages > LIMITS.maxDocumentPages) {
    return { ok: false, code: 'TOO_MANY_PAGES', message: `Documents can have up to ${LIMITS.maxDocumentPages} pages.` };
  }
  if (level(u.platformStorageUsedPct) === 'block') {
    return { ok: false, code: 'PLATFORM_FULL', message: 'Storage is nearly full, so new uploads are paused. Nothing you already have is affected.' };
  }
  if (u.userUsedBytes + u.sizeBytes > u.userQuotaBytes) {
    return { ok: false, code: 'USER_QUOTA', message: `This would go over your ${mb(u.userQuotaBytes)} MB storage allowance.` };
  }
  return { ok: true };
}

/** Free-tier thresholds: warn at 70%, block new registrations/uploads at 90%. */
export function level(usedPct: number): 'ok' | 'warn' | 'block' {
  if (usedPct >= 90) return 'block';
  if (usedPct >= 70) return 'warn';
  return 'ok';
}

/** When a restricted account may become trusted. Self-signing alone never qualifies. */
export function trustUpgradeEligible(a: {
  completedWithExternalRecipient: number;
  accountAgeDays: number;
  openAbuseReports: number;
  adminTrusted: boolean;
}): boolean {
  if (a.adminTrusted) return true;
  return a.completedWithExternalRecipient >= 1 && a.accountAgeDays >= 7 && a.openAbuseReports === 0;
}
