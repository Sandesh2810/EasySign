// Email templates. Plain functions returning { subject, html, text }.
// Single column, system fonts with web-safe fallbacks, one clear button, and a full plain-text version.
// Every value that comes from a person is escaped.
import { PRODUCT_NAME } from '@/config/brand';

export const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A subject is one line: control characters (including line breaks) from a title or a name are removed. */
export const oneLine = (s: string) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function layout(opts: { preheader: string; heading: string; paragraphs: string[]; button?: { label: string; url: string }; footnote?: string }): string {
  const p = opts.paragraphs.map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#373330;">${t}</p>`).join('');
  const button = opts.button
    ? `<p style="margin:24px 0;"><a href="${esc(opts.button.url)}" style="display:inline-block;background:#1a1818;color:#fffcf4;text-decoration:none;font-size:16px;line-height:20px;padding:14px 28px;border-radius:9999px;">${esc(opts.button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#5e5a55;">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;color:#4e57b8;">${esc(opts.button.url)}</span></p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(opts.heading)}</title></head>
<body style="margin:0;background:#f5f4ef;font-family:'Hanken Grotesk','Helvetica Neue',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4ef;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:24px;"><tr><td style="padding:36px 32px;">
<p style="margin:0 0 24px;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:#5e5a55;">${esc(PRODUCT_NAME)}</p>
<h1 style="margin:0 0 20px;font-size:26px;line-height:32px;font-weight:400;color:#1a1818;">${esc(opts.heading)}</h1>
${p}${button}
${opts.footnote ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e3e0d7;font-size:13px;line-height:20px;color:#5e5a55;">${opts.footnote}</p>` : ''}
</td></tr></table>
</td></tr></table></body></html>`;
}

export function verifyEmailTemplate(v: { name: string; confirmUrl: string }): RenderedEmail {
  const subject = `Confirm your email for ${PRODUCT_NAME}`;
  return {
    subject,
    html: layout({
      preheader: 'One click to finish creating your account.',
      heading: 'Confirm your email address',
      paragraphs: [`Hello ${esc(v.name)},`, `Someone used this address to create a ${esc(PRODUCT_NAME)} account. If that was you, confirm it to finish signing up.`],
      button: { label: 'Confirm email', url: v.confirmUrl },
      footnote: 'If you did not create an account, you can ignore this email. Nothing happens unless the link is used.',
    }),
    text: [
      `Hello ${v.name},`,
      '',
      `Someone used this address to create a ${PRODUCT_NAME} account. If that was you, open this link to confirm it:`,
      v.confirmUrl,
      '',
      'If you did not create an account, ignore this email. Nothing happens unless the link is used.',
    ].join('\n'),
  };
}

export function signatureRequestTemplate(v: { signerName: string; senderName: string; title: string; signUrl: string; expiresOn: string }): RenderedEmail {
  const subject = oneLine(`${v.senderName} sent you "${v.title}" to sign`);
  return {
    subject,
    html: layout({
      preheader: `Review and sign "${v.title}".`,
      heading: 'A document is waiting for your signature',
      paragraphs: [
        `Hello ${esc(v.signerName)},`,
        `${esc(v.senderName)} has sent you <strong>${esc(v.title)}</strong> to review and sign. It takes a few minutes and you do not need an account.`,
      ],
      button: { label: 'Review and sign', url: v.signUrl },
      footnote: `This link is personal to you and works until ${esc(v.expiresOn)}. Do not forward this email: anyone who has the link can sign as you. If you were not expecting this document, ignore this email.`,
    }),
    text: [
      `Hello ${v.signerName},`,
      '',
      `${v.senderName} has sent you "${v.title}" to review and sign. You do not need an account. Open this link:`,
      v.signUrl,
      '',
      `The link is personal to you and works until ${v.expiresOn}. Do not forward this email: anyone who has the link can sign as you.`,
      'If you were not expecting this document, ignore this email.',
    ].join('\n'),
  };
}

export function completionTemplate(v: { name: string; title: string; code: string; finalSha256: string; openUrl?: string }): RenderedEmail {
  const subject = oneLine(`Completed: "${v.title}"`);
  return {
    subject,
    html: layout({
      preheader: 'Everyone has signed. Your copy is attached.',
      heading: 'Everyone has signed',
      paragraphs: [
        `Hello ${esc(v.name)},`,
        `<strong>${esc(v.title)}</strong> is complete. The signed PDF and its certificate of completion are attached to this email. Keep them somewhere safe.`,
        `Verification code: <span style="font-family:Consolas,Menlo,monospace;">${esc(v.code)}</span>`,
      ],
      button: v.openUrl ? { label: 'Open in ' + PRODUCT_NAME, url: v.openUrl } : undefined,
      footnote: `SHA-256 of the signed PDF: <span style="word-break:break-all;font-family:Consolas,Menlo,monospace;">${esc(v.finalSha256)}</span>`,
    }),
    text: [
      `Hello ${v.name},`,
      '',
      `"${v.title}" is complete. The signed PDF and its certificate of completion are attached. Keep them somewhere safe.`,
      `Verification code: ${v.code}`,
      `SHA-256 of the signed PDF: ${v.finalSha256}`,
      ...(v.openUrl ? ['', v.openUrl] : []),
    ].join('\n'),
  };
}
