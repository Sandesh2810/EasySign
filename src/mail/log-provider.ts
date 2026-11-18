// NOTIFY_MODE=log: nothing leaves the machine. Each email is written to the dev outbox folder
// (app\.dev-outbox, gitignored) as an .html file you can open plus a .json file with the details.
// The files contain working sign-in/signing links on purpose, which is why they are never written
// to the database or to logs (AT1.5, DECISIONS D-21).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { looksLikeEmail, type MailMessage, type MailProvider, type MailResult } from './types';

const slug = (s: string, max: number) => s.replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/\.{2,}/g, '_').replace(/^[._-]+/, '').slice(0, max) || 'x';

export class LogMailProvider implements MailProvider {
  readonly name = 'log';
  constructor(private readonly dir: string) {}

  async send(message: MailMessage): Promise<MailResult> {
    if (!looksLikeEmail(message.to)) throw new Error('Mail message has no valid recipient');
    mkdirSync(this.dir, { recursive: true });
    const keyHash = createHash('sha256').update(message.idempotencyKey, 'utf8').digest('hex').slice(0, 16);
    const id = `log-${keyHash}`;
    const marker = path.join(this.dir, `${id}.json`);
    if (existsSync(marker)) return { id: (JSON.parse(readFileSync(marker, 'utf8')) as { id: string }).id };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlName = `${stamp}_${slug(message.kind, 30)}_${slug(message.to, 60)}_${keyHash}.html`;
    writeFileSync(path.join(this.dir, htmlName), message.html, 'utf8');
    writeFileSync(
      marker,
      JSON.stringify(
        {
          id,
          mode: 'log',
          writtenAt: new Date().toISOString(),
          to: message.to,
          replyTo: message.replyTo ?? null,
          kind: message.kind,
          subject: message.subject,
          text: message.text,
          htmlFile: htmlName,
          attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: a.content.length })),
        },
        null,
        2,
      ),
      'utf8',
    );
    return { id };
  }
}
