// Sends email through Resend's HTTP API (DECISIONS D-16, D-61). No extra package: one HTTPS request per email.
// Facts used here, from Resend's own documentation (checked 2026-11-19, see D-61):
//   POST https://api.resend.com/emails with a Bearer key; body: from, to[], subject, html, text, reply_to, attachments[{filename, content(base64)}]
//   Idempotency-Key header: same key within 24 hours = one email; a retry returns the first response; 409 while the first is still running
//   at most 40 MB of attachments per email after base64 encoding
//   429 with daily_quota_exceeded / monthly_quota_exceeded when the plan's quota is used up; 429 rate_limit_exceeded above 10 requests a second
// Two modes:
//   sandbox: only the addresses listed in SANDBOX_RECIPIENTS can receive anything; every other email is refused
//            before it leaves this computer. For trying real delivery without writing to anyone else.
//   live:    every recipient. Only the owner switches this on (NOTIFY_MODE=live), after his explicit go-ahead.
import { looksLikeEmail, MailQuotaError, type MailMessage, type MailProvider, type MailResult } from './types';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Resend's limit is 40 MB after base64; a little is kept back for the message itself. */
export const MAX_ATTACHMENT_BASE64_BYTES = 38 * 1024 * 1024;

/** An email that must not be sent as it is. The worker records it as failed; it is not retried. */
export class MailRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailRefusedError';
  }
}

export interface ResendOptions {
  apiKey: string;
  /** e.g. "YouNMeSign <notify@younmesign.com>" */
  from: string;
  mode: 'sandbox' | 'live';
  /** sandbox only: the addresses that may receive email */
  allowed?: string[];
  fetchImpl?: typeof fetch;
}

const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);
/** Strips anything that could start a new header line. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function checkFromAddress(from: string): string | null {
  const m = /^(?:[^<>"\r\n]{1,60} )?<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/.exec(from.trim());
  return m ? null : 'MAIL_FROM must look like "YouNMeSign <notify@your-domain>" or "notify@your-domain".';
}

export class ResendMailProvider implements MailProvider {
  readonly name: string;
  private readonly allowed: Set<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResendOptions) {
    if (!opts.apiKey || !opts.apiKey.startsWith('re_')) throw new Error('RESEND_API_KEY is missing or does not look like a Resend key (it starts with re_).');
    const fromProblem = checkFromAddress(opts.from);
    if (fromProblem) throw new Error(fromProblem);
    this.allowed = new Set((opts.allowed ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean));
    if (opts.mode === 'sandbox' && this.allowed.size === 0) throw new Error('NOTIFY_MODE=sandbox needs SANDBOX_RECIPIENTS: the only addresses that may receive email.');
    this.name = `resend-${opts.mode}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: MailMessage): Promise<MailResult> {
    const to = message.to.trim().toLowerCase();
    if (!looksLikeEmail(to)) throw new MailRefusedError('Mail message has no valid recipient');
    if (this.opts.mode === 'sandbox' && !this.allowed.has(to)) {
      throw new MailRefusedError('sandbox mode: this address is not in SANDBOX_RECIPIENTS, so nothing was sent');
    }
    const attachments = (message.attachments ?? []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64'), content_type: a.contentType }));
    const attachmentBytes = (message.attachments ?? []).reduce((n, a) => n + base64Length(a.content.length), 0);
    if (attachmentBytes > MAX_ATTACHMENT_BASE64_BYTES) {
      throw new MailRefusedError('the attachments are larger than the email provider accepts (40 MB)');
    }

    const body: Record<string, unknown> = { from: this.opts.from, to: [to], subject: oneLine(message.subject), html: message.html, text: message.text };
    if (message.replyTo && looksLikeEmail(message.replyTo)) body.reply_to = [message.replyTo.trim()];
    if (attachments.length) body.attachments = attachments;

    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          // Resend keeps a key for 24 hours and allows 256 characters; ours are short and stable per email.
          'Idempotency-Key': message.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('the email provider could not be reached');
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
    if (res.ok && typeof data.id === 'string') return { id: data.id };
    const name = String(data.name ?? '');
    if (res.status === 429 && name === 'daily_quota_exceeded') throw new MailQuotaError('daily');
    if (res.status === 429 && name === 'monthly_quota_exceeded') throw new MailQuotaError('monthly');
    // The error text from the provider never contains the API key; only its short name is kept.
    if (res.status === 429 || res.status === 409 || res.status >= 500) throw new Error(`the email provider asked us to try again later (${res.status}${name ? ` ${name}` : ''})`);
    throw new MailRefusedError(`the email provider refused this email (${res.status}${name ? ` ${name}` : ''})`);
  }
}
