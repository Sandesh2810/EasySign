// Product constants. Changeable without touching feature code.
// Runtime-switchable settings (REGISTRATION_MODE, quotas) live in the platform_settings table.

export const PRODUCT_NAME = 'EasySign';
export const DEFAULT_TIMEZONE = 'America/Chicago';
export const THEME = 'AlterMe';

export const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

export type NotifyMode = 'log' | 'sandbox' | 'live';
export const NOTIFY_MODE: NotifyMode = (['log', 'sandbox', 'live'] as const).includes(
  process.env.NOTIFY_MODE as NotifyMode,
)
  ? (process.env.NOTIFY_MODE as NotifyMode)
  : 'log';

export type RegistrationMode = 'open' | 'approval' | 'invite_only';
/** Code default per the brief; the launch value chosen by the owner is `approval` (DECISIONS D-15). */
export const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'open';

export const LIMITS = {
  maxDocumentBytes: 10 * 1024 * 1024,
  maxDocumentPages: 100,
  defaultUserStorageBytes: 50 * 1024 * 1024,
  restricted: { envelopesPerDay: 3, externalRecipientsPerDay: 5 },
  retentionYearsDefault: 7,
} as const;

export const NO_PHI_NOTICE =
  'Do not upload documents containing protected health information (PHI). EasySign is for business contracts only.';
