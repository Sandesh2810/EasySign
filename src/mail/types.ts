// MailProvider: the only thing that actually sends email. The Email Budget Manager decides whether a
// message may be handed to a provider; providers never make that decision themselves.

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface MailMessage {
  to: string;
  /** e.g. signature_request, completion_copy, auth_verify */
  kind: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  /** Same key => at most one email, however many times send() is called. */
  idempotencyKey: string;
}

export interface MailResult {
  /** provider message id */
  id: string;
}

/** Thrown when the provider itself reports the daily or monthly quota as exhausted. */
export class MailQuotaError extends Error {
  constructor(public readonly scope: 'daily' | 'monthly') {
    super(`Email provider ${scope} quota reached`);
    this.name = 'MailQuotaError';
  }
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<MailResult>;
}

export const looksLikeEmail = (s: string) => typeof s === 'string' && s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
