// In-app notices: one place that turns a stored notice (kind + small payload) into words.
// Used by the Notifications page and by the daily digest email, so both always say the same thing.
// Pure: no I/O. Values from people (names, titles) are returned as plain text; the caller escapes them.

export interface NoticeView {
  text: string;
  /** Where "open" should lead, inside the app; null when there is nothing to open. */
  path: string | null;
  tone: 'good' | 'info' | 'attention';
}

const EMAIL_LABEL: Record<string, string> = {
  signature_request: 'the request to sign',
  approval_request: 'the request to approve',
  view_notice: 'the notice to read',
  reminder: 'a reminder',
  completion_copy: 'a copy of the completed document',
  completion_sender: 'your copy of the completed document',
  declined_sender: 'the notice that it was declined',
  voided_notice: 'the notice that it was cancelled',
  expired_sender: 'the notice that it expired',
  paper_copy_sender: 'the notice about a paper-copy request',
  withdrawn_sender: 'the notice that consent was withdrawn',
  digest: 'your daily summary',
};

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function describeNotification(kind: string, payload: unknown): NoticeView {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const id = str(p.envelope_id, 40);
  const path = UUID.test(id) ? `/app/envelopes/${id}` : null;
  const title = str(p.title) ? `"${str(p.title)}"` : 'a document';
  const by = str(p.by, 120) || 'Someone';
  const email = EMAIL_LABEL[str(p.kind, 40)] ?? 'an email';

  switch (kind) {
    case 'recipient_signed':
      return { text: `${by} signed ${title}.`, path, tone: 'good' };
    case 'recipient_approved':
      return { text: `${by} approved ${title}.`, path, tone: 'good' };
    case 'envelope_completed':
      return { text: `${title} is complete. Everyone has finished and the sealed copy is ready to download.`, path, tone: 'good' };
    case 'envelope_declined':
      return { text: `${by} declined ${title}. The document is closed and nobody else can sign it.`, path, tone: 'attention' };
    case 'consent_withdrawn':
      return {
        text: `${by} withdrew their consent to sign ${title} electronically. What they had filled in was cleared and they cannot sign until they agree again. Open the document to decide what to do.`,
        path,
        tone: 'attention',
      };
    case 'paper_copy_requested':
      return { text: `${by} asked for a paper copy of ${title}. Open the document to see the request and mark it done when you have sent it.`, path, tone: 'attention' };
    case 'envelope_expired':
      return { text: `${title} expired before everyone had finished. Its signing links no longer work.`, path, tone: 'attention' };
    case 'sealing_failed':
      return { text: `The final sealed copy of ${title} could not be produced. Contact the administrator.`, path, tone: 'attention' };
    case 'email_failed':
      return {
        text: `An email could not be delivered after several attempts (${email}). Open the document to send it again or to copy the link and share it yourself.`,
        path,
        tone: 'attention',
      };
    case 'email_deferred':
      return {
        text: `Today's email allowance is used up, so ${email} for ${title} will go out after the daily reset. If it is urgent, open the document, copy the link and share it yourself.`,
        path,
        tone: 'attention',
      };
    case 'signer_locked':
      return {
        text:
          p.needs_sender === true
            ? `${by} entered the wrong code too many times for ${title}. Their link is locked until you unlock it on the document page. Check with them first that it really was them.`
            : `${by} entered the wrong code too many times for ${title}. Their link is locked for a short while and then works again.`,
        path,
        tone: 'attention',
      };
    case 'abuse_report':
      return { text: `Someone reported ${title} as suspicious. Open Accounts to read the report and decide what to do.`, path: '/app/admin', tone: 'attention' };
    case 'account_suspended':
      return {
        text: 'Your account has been suspended by the administrator. Your open documents are on hold: nobody can sign them for now, and you cannot send new ones. Completed documents are not affected. Contact the administrator.',
        path: null,
        tone: 'attention',
      };
    case 'account_suspension_lifted':
      return { text: 'The suspension of your account has been lifted. Your open documents continue and you can send again.', path: null, tone: 'good' };
    case 'mfa_reset':
      return {
        text: 'The administrator removed your two-step sign-in, as you asked. Set it up again now under Security. If you did not ask for this, contact the administrator straight away.',
        path: '/app/account/security',
        tone: 'attention',
      };
    case 'account_approved':
      return { text: 'Your account was approved. You can now send documents to other people.', path: null, tone: 'good' };
    case 'account_approval_removed':
      return { text: 'Approval for your account was removed. You can still prepare documents and sign them yourself.', path: null, tone: 'attention' };
    default:
      return { text: 'There is an update on your account.', path, tone: 'info' };
  }
}
