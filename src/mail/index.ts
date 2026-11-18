// Chooses the mail provider from NOTIFY_MODE. Only "log" exists so far: nothing can leave the machine.
import 'server-only';
import path from 'node:path';
import { NOTIFY_MODE } from '@/config/brand';
import { LogMailProvider } from './log-provider';
import type { MailProvider } from './types';

export const DEV_OUTBOX_DIR = path.join(process.cwd(), '.dev-outbox');

let provider: MailProvider | null = null;

export function getMailProvider(): MailProvider {
  if (provider) return provider;
  if (NOTIFY_MODE === 'log') {
    provider = new LogMailProvider(DEV_OUTBOX_DIR);
    return provider;
  }
  // sandbox and live need the Resend provider and a verified sending domain (Phase 2), plus the owner's explicit go-ahead.
  throw new Error(`NOTIFY_MODE=${NOTIFY_MODE} is not available yet. Set NOTIFY_MODE=log.`);
}
