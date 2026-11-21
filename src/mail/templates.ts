// Email templates. Plain functions returning { subject, html, text }.
// Single column, system fonts with web-safe fallbacks, one clear button, and a full plain-text version.
// Every value that comes from a person is escaped.
import { PRODUCT_NAME } from '@/config/brand';
import { translator } from '@/i18n/catalog';
import { dirOf, type Locale } from '@/i18n/config';
import { format, type MessageKey, type T, type Vars } from '@/i18n/format';

export const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A subject is one line: control characters (including line breaks) from a title or a name are removed. */
export const oneLine = (s: string) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** D-95: a message for the HTML version: the words are escaped, the values are given as ready HTML. */
const th = (t: T, key: MessageKey, vars: Vars = {}) => format(esc(t(key)), vars);

function layout(opts: { preheader: string; heading: string; paragraphs: string[]; button?: { label: string; url: string }; footnote?: string; locale?: Locale }): string {
  const locale = opts.locale ?? 'en';
  const t = translator(locale);
  const p = opts.paragraphs.map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#373330;">${t}</p>`).join('');
  const button = opts.button
    ? `<p style="margin:24px 0;"><a href="${esc(opts.button.url)}" style="display:inline-block;background:#1a1818;color:#fffcf4;text-decoration:none;font-size:16px;line-height:20px;padding:14px 28px;border-radius:9999px;">${esc(opts.button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#5e5a55;">${esc(t('email.buttonFallback'))}<br><span style="word-break:break-all;color:#4e57b8;">${esc(opts.button.url)}</span></p>`
    : '';
  return `<!doctype html>
<html lang="${locale}"${dirOf(locale) === 'rtl' ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(opts.heading)}</title></head>
<body style="margin:0;background:#f5f4ef;font-family:'Hanken Grotesk','Helvetica Neue',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4ef;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:24px;"><tr><td style="padding:36px 32px;">
<!--brand:header--><p style="margin:0 0 24px;font-size:14px;letter-spacing:0.02em;color:#5e5a55;">${esc(PRODUCT_NAME)}</p><!--/brand:header-->
<h1 style="margin:0 0 20px;font-size:26px;line-height:32px;font-weight:400;color:#1a1818;">${esc(opts.heading)}</h1>
${p}${button}
${opts.footnote ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e3e0d7;font-size:13px;line-height:20px;color:#5e5a55;">${opts.footnote}</p>` : ''}
<!--brand:footer-->
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

/** What the person receiving a request is asked to do. */
export type RequestPurpose = 'sign' | 'approve' | 'view';

export function signatureRequestTemplate(v: { signerName: string; senderName: string; title: string; signUrl: string; expiresOn: string; purpose?: RequestPurpose; reminder?: boolean; locale?: Locale }): RenderedEmail {
  const t = translator(v.locale ?? 'en');
  const P = ({ sign: 'Sign', approve: 'Approve', view: 'View' } as const)[v.purpose ?? 'sign'];
  const k = (suffix: string) => `email.req${P}${suffix}` as MessageKey;
  const subject = oneLine(v.reminder ? t(k('ReminderSubject'), { title: v.title }) : t(k('Subject'), { sender: v.senderName, title: v.title }));
  const noAction = v.purpose === 'view' ? t('email.viewNoAction') : t('email.fewMinutes');
  const button = t(k('Button'));
  const act = t(k('Act'));
  return {
    subject,
    html: layout({
      locale: v.locale,
      preheader: t('email.reqPreheader', { button, title: v.title }),
      heading: t(k(v.reminder ? 'ReminderHeading' : 'Heading')),
      paragraphs: [
        th(t, 'email.hello', { name: esc(v.signerName) }),
        v.reminder
          ? `${th(t, k('ReminderBody'), { sender: esc(v.senderName), title: `<strong>${esc(v.title)}</strong>` })} ${esc(t('email.noAccount'))}`
          : `${th(t, k('Body'), { sender: esc(v.senderName), title: `<strong>${esc(v.title)}</strong>` })} ${esc(noAction)} ${esc(t('email.noAccount'))}`,
      ],
      button: { label: button, url: v.signUrl },
      footnote: th(t, 'email.reqFootnote', { date: esc(v.expiresOn), act: esc(act) }),
    }),
    text: [
      t('email.hello', { name: v.signerName }),
      '',
      v.reminder
        ? `${t(k('ReminderBody'), { sender: v.senderName, title: `"${v.title}"` })} ${t('email.noAccount')} ${t('email.openThisLink')}`
        : `${t(k('Body'), { sender: v.senderName, title: `"${v.title}"` })} ${noAction} ${t('email.noAccount')} ${t('email.openThisLink')}`,
      v.signUrl,
      '',
      t('email.reqTextPersonal', { date: v.expiresOn, act }),
      t('email.reqTextUnexpected'),
    ].join('\n'),
  };
}

/** D-84: the sender answered a person's question about a document; their link opens it again. */
export function commentReplyTemplate(v: { name: string; senderName: string; title: string; answer: string; signUrl: string; expiresOn: string; locale?: Locale }): RenderedEmail {
  const t = translator(v.locale ?? 'en');
  const subject = oneLine(t('email.replySubject', { sender: v.senderName, title: v.title }));
  return {
    subject,
    html: layout({
      locale: v.locale,
      preheader: t('email.replyPreheader', { sender: v.senderName }),
      heading: t('email.replyHeading'),
      paragraphs: [
        th(t, 'email.hello', { name: esc(v.name) }),
        th(t, 'email.replyBody', { sender: esc(v.senderName), title: `<strong>${esc(v.title)}</strong>` }),
        `<span style="display:block;padding:12px 16px;border-left:3px solid #e3e0d7;white-space:pre-wrap;">${esc(v.answer)}</span>`,
        esc(t('email.replyConversation')),
      ],
      button: { label: t('email.replyOpen'), url: v.signUrl },
      footnote: th(t, 'email.replyFootnote', { date: esc(v.expiresOn) }),
    }),
    text: [
      t('email.hello', { name: v.name }),
      '',
      t('email.replyBody', { sender: v.senderName, title: `"${v.title}"` }),
      '',
      v.answer,
      '',
      `${t('email.replyConversation')} ${t('email.openThisLink')}`,
      v.signUrl,
      '',
      t('email.replyTextFootnote', { date: v.expiresOn }),
    ].join('\n'),
  };
}

/** Tells the sender that a document reached its expiry date before everyone finished. */
/** The six-digit code a signer asked for on the code screen. No link: the code is typed into the page they already have open. */
export function otpTemplate(v: { name: string; title: string; code: string; minutes: number; locale?: Locale }): RenderedEmail {
  const t = translator(v.locale ?? 'en');
  const spaced = `${v.code.slice(0, 3)} ${v.code.slice(3)}`;
  const subject = oneLine(t('email.otpSubject', { title: v.title }));
  return {
    subject,
    html: layout({
      locale: v.locale,
      preheader: t('email.otpPreheader', { minutes: v.minutes }),
      heading: t('email.otpHeading'),
      paragraphs: [
        th(t, 'email.hello', { name: esc(v.name) }),
        th(t, 'email.otpBody', { title: `<strong>${esc(v.title)}</strong>` }),
        `<span dir="ltr" style="display:inline-block;font-size:32px;line-height:40px;letter-spacing:0.12em;font-weight:600;color:#1a1818;">${esc(spaced)}</span>`,
        th(t, 'email.otpValidity', { minutes: v.minutes }),
      ],
      footnote: th(t, 'email.otpFootnote', { product: esc(PRODUCT_NAME) }),
    }),
    text: [
      t('email.hello', { name: v.name }),
      '',
      t('email.otpBody', { title: `"${v.title}"` }),
      '',
      `    ${spaced}`,
      '',
      t('email.otpValidity', { minutes: v.minutes }),
      '',
      t('email.otpFootnote', { product: PRODUCT_NAME }),
    ].join('\n'),
  };
}

/** The opt-in daily summary: one email listing what happened on the person's documents. */
export function digestTemplate(v: { name: string; lines: string[]; more: number; openUrl: string }): RenderedEmail {
  const n = v.lines.length + v.more;
  const subject = `${PRODUCT_NAME}: ${n} update${n === 1 ? '' : 's'} on your documents`;
  const more = v.more > 0 ? `And ${v.more} more. Open your notifications to see everything.` : '';
  return {
    subject,
    html: layout({
      preheader: oneLine(v.lines[0] ?? 'Your daily summary'),
      heading: 'Your daily summary',
      paragraphs: [
        `Hello ${esc(v.name)},`,
        'This is what happened on your documents since the last summary:',
        `<ul style="margin:0 0 0 20px;padding:0;">${v.lines.map((l) => `<li style="margin:0 0 8px;">${esc(l)}</li>`).join('')}</ul>`,
        ...(more ? [esc(more)] : []),
      ],
      button: { label: 'Open notifications', url: v.openUrl },
      footnote: 'You get this summary because you switched it on. You can switch it off on the Notifications page; everything stays visible there either way.',
    }),
    text: [
      `Hello ${v.name},`,
      '',
      'This is what happened on your documents since the last summary:',
      ...v.lines.map((l) => `- ${l}`),
      ...(more ? ['', more] : []),
      '',
      v.openUrl,
      '',
      'You get this summary because you switched it on. You can switch it off on the Notifications page.',
    ].join('\n'),
  };
}

export function expiredTemplate(v: { name: string; title: string; openUrl: string }): RenderedEmail {
  const subject = oneLine(`Expired: "${v.title}"`);
  return {
    subject,
    html: layout({
      preheader: 'Not everyone finished in time. The links no longer work.',
      heading: 'Your document expired',
      paragraphs: [
        `Hello ${esc(v.name)},`,
        `<strong>${esc(v.title)}</strong> reached its expiry date before everyone had finished. Every signing link has been switched off and nothing was completed.`,
        'To try again, create a new document. You can choose a longer time limit when you send it.',
      ],
      button: { label: 'Open the document', url: v.openUrl },
    }),
    text: [
      `Hello ${v.name},`,
      '',
      `"${v.title}" reached its expiry date before everyone had finished. Every signing link has been switched off and nothing was completed.`,
      'To try again, create a new document. You can choose a longer time limit when you send it.',
      '',
      v.openUrl,
    ].join('\n'),
  };
}

/** Tells someone who had already been asked that the sender has cancelled the document. */
export function voidedTemplate(v: { name: string; senderName: string; title: string; locale?: Locale }): RenderedEmail {
  const t = translator(v.locale ?? 'en');
  const subject = oneLine(t('email.voidSubject', { title: v.title }));
  return {
    subject,
    html: layout({
      locale: v.locale,
      preheader: t('email.voidPreheader', { sender: v.senderName }),
      heading: t('email.voidHeading'),
      paragraphs: [
        th(t, 'email.hello', { name: esc(v.name) }),
        th(t, 'email.voidBody', { sender: esc(v.senderName), title: `<strong>${esc(v.title)}</strong>` }),
        esc(t('email.voidSigned')),
      ],
      footnote: th(t, 'email.voidFootnote', { sender: esc(v.senderName) }),
    }),
    text: [
      t('email.hello', { name: v.name }),
      '',
      t('email.voidBody', { sender: v.senderName, title: `"${v.title}"` }),
      t('email.voidSigned'),
      '',
      t('email.voidTextFootnote', { sender: v.senderName }),
    ].join('\n'),
  };
}

/** Tells the sender that someone declined, which stops the document for everyone. */
export function declinedTemplate(v: { name: string; title: string; declinedBy: string; reason: string | null; openUrl: string }): RenderedEmail {
  const subject = oneLine(`Declined: "${v.title}"`);
  const reason = v.reason ? `Their reason: “${v.reason}”` : 'They did not give a reason.';
  return {
    subject,
    html: layout({
      preheader: `${v.declinedBy} declined. The document has been stopped.`,
      heading: 'Your document was declined',
      paragraphs: [
        `Hello ${esc(v.name)},`,
        `${esc(v.declinedBy)} declined <strong>${esc(v.title)}</strong>. The document has been stopped for everyone and every signing link has been switched off. Nothing was completed.`,
        esc(reason),
        'To try again, create a new document.',
      ],
      button: { label: 'Open the document', url: v.openUrl },
    }),
    text: [
      `Hello ${v.name},`,
      '',
      `${v.declinedBy} declined "${v.title}". The document has been stopped for everyone and every signing link has been switched off. Nothing was completed.`,
      reason,
      'To try again, create a new document.',
      '',
      v.openUrl,
    ].join('\n'),
  };
}

export function completionTemplate(v: { name: string; title: string; code: string; finalSha256: string; openUrl?: string; locale?: Locale }): RenderedEmail {
  const t = translator(v.locale ?? 'en');
  const subject = oneLine(t('email.doneSubject', { title: v.title }));
  return {
    subject,
    html: layout({
      locale: v.locale,
      preheader: t('email.donePreheader'),
      heading: t('email.doneHeading'),
      paragraphs: [
        th(t, 'email.hello', { name: esc(v.name) }),
        th(t, 'email.doneBody', { title: `<strong>${esc(v.title)}</strong>` }),
        th(t, 'email.doneCode', { code: `<span style="font-family:Consolas,Menlo,monospace;">${esc(v.code)}</span>` }),
      ],
      button: v.openUrl ? { label: t('email.doneOpen', { product: PRODUCT_NAME }), url: v.openUrl } : undefined,
      footnote: th(t, 'email.doneSha', { sha: `<span style="word-break:break-all;font-family:Consolas,Menlo,monospace;">${esc(v.finalSha256)}</span>` }),
    }),
    text: [
      t('email.hello', { name: v.name }),
      '',
      t('email.doneTextBody', { title: `"${v.title}"` }),
      t('email.doneCode', { code: v.code }),
      t('email.doneSha', { sha: v.finalSha256 }),
      ...(v.openUrl ? ['', v.openUrl] : []),
    ].join('\n'),
  };
}

/** To the sender: a signer asked for a paper copy, or withdrew consent to sign electronically (Phase 3, AT3.3). */
export function senderTaskTemplate(v: { name: string; title: string; by: string; kind: 'paper_copy' | 'consent_withdrawn'; note: string | null; openUrl: string }): RenderedEmail {
  const paper = v.kind === 'paper_copy';
  const subject = oneLine(paper ? `Paper copy requested: "${v.title}"` : `Consent withdrawn: "${v.title}"`);
  const what = paper
    ? `${v.by} asked for a paper copy of "${v.title}". Please arrange one; how you provide it is up to you. When it is done, mark the request as done on the document page.`
    : `${v.by} withdrew their consent to sign "${v.title}" electronically. What they had filled in or signed was cleared, and they cannot sign until they agree again. The document stays open: you can send them a paper copy, correct the recipient or cancel the document.`;
  const note = v.note ? `${paper ? 'Their note' : 'Their reason'}: “${v.note}”` : null;
  return {
    subject,
    html: layout({
      preheader: paper ? `${v.by} asked for a paper copy.` : `${v.by} withdrew consent to sign electronically.`,
      heading: paper ? 'A paper copy was requested' : 'Consent to sign electronically was withdrawn',
      paragraphs: [`Hello ${esc(v.name)},`, esc(what), ...(note ? [esc(note)] : [])],
      button: { label: 'Open the document', url: v.openUrl },
    }),
    text: [`Hello ${v.name},`, '', what, ...(note ? [note] : []), '', v.openUrl].join('\n'),
  };
}

/** D-88: a workspace's branding, applied to an email for one of its documents. */
export interface EmailBrand {
  name: string;
  color: string;
  textColor: string;
  footer: string | null;
}

const BUTTON_STYLE = 'background:#1a1818;color:#fffcf4;';
const COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * Puts the workspace's name on a band in its brand colours at the top (with "Sent with YouNMeSign" under it), gives the
 * button the brand colours (the pair passed the contrast check when it was saved), and adds the footer to the HTML and
 * the plain text. Everything from the workspace is escaped; colours that are not "#RRGGBB" are ignored.
 */
export function brandEmail(email: RenderedEmail, brand: EmailBrand | null, locale: Locale = 'en'): RenderedEmail {
  const t = translator(locale);
  if (!brand || !COLOR.test(brand.color) || !COLOR.test(brand.textColor)) return email;
  const name = oneLine(brand.name) || PRODUCT_NAME;
  const header =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr><td style="background:${brand.color};color:${brand.textColor};padding:12px 16px;border-radius:12px;font-size:16px;line-height:22px;font-weight:600;">${esc(name)}</td></tr></table>` +
    `<p style="margin:0 0 24px;font-size:12px;line-height:18px;color:#5e5a55;">${th(t, 'email.sentWith', { product: esc(PRODUCT_NAME) })}</p>`;
  const footer = brand.footer?.trim()
    ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e3e0d7;font-size:13px;line-height:20px;color:#5e5a55;white-space:pre-line;">${esc(brand.footer.trim())}</p>`
    : '';
  const html = email.html
    .replace(/<!--brand:header-->[\s\S]*?<!--\/brand:header-->/, header)
    .split(BUTTON_STYLE)
    .join(`background:${brand.color};color:${brand.textColor};`)
    .replace('<!--brand:footer-->', footer);
  const footerText = brand.footer?.trim() ? `\n\n--\n${brand.footer.trim()}` : '';
  const text = `${name} (${t('email.sentWithText', { product: PRODUCT_NAME })})\n\n${email.text}${footerText}`;
  return { subject: email.subject, html, text };
}
