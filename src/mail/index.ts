// Chooses the mail provider from NOTIFY_MODE.
//   log     (default): nothing leaves the computer; emails are written to app\.dev-outbox.
//   sandbox: real email through Resend, but only to the addresses in SANDBOX_RECIPIENTS.
//   live:    real email to everyone. Only after the owner's explicit go-ahead (CLAUDE.md); he sets it himself.
import 'server-only';
import path from 'node:path';
import { NOTIFY_MODE } from '@/config/brand';
import { LogMailProvider } from './log-provider';
import { ResendMailProvider } from './resend-provider';
import type { MailProvider } from './types';

export const DEV_OUTBOX_DIR = path.join(process.cwd(), '.dev-outbox');

let provider: MailProvider | null = null;

export function getMailProvider(): MailProvider {
  if (provider) return provider;
  if (NOTIFY_MODE === 'log') {
    provider = new LogMailProvider(DEV_OUTBOX_DIR);
    return provider;
  }
  provider = new ResendMailProvider({
    apiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.MAIL_FROM ?? '',
    mode: NOTIFY_MODE,
    allowed: (process.env.SANDBOX_RECIPIENTS ?? '').split(','),
  });
  return provider;
}
