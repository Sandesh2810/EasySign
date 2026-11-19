// The document page's history: audit events in plain words (brief: "status timeline").
// Pure; no I/O. Only the event type and who it concerns are used; payloads are not shown.

const LABELS: Record<string, string> = {
  envelope_created: 'Document created',
  document_uploaded: 'File uploaded',
  fields_changed: 'Fields placed or changed',
  recipient_check_set: 'Extra identity check chosen',
  envelope_sent: 'Sent',
  recipient_activated: 'Asked to act',
  email_queued: 'Email queued',
  email_sent: 'Email sent',
  email_deferred: 'Email held until the next daily allowance',
  email_failed: 'Email could not be delivered',
  link_revealed: 'Signing links shown to the sender',
  link_opened: 'Opened the link',
  out_of_turn: 'Tried to open the link before their turn',
  token_failed: 'A link that no longer works was used',
  link_on_hold: 'Tried to open the link while the document was on hold',
  consent_given: 'Agreed to sign electronically',
  code_requested: 'Asked for an emailed code',
  check_passed: 'Passed the extra identity check',
  check_failed: 'Entered a wrong code',
  link_locked: 'Link locked after too many wrong codes',
  link_unlocked: 'Link unlocked by the sender',
  signature_adopted: 'Created their signature',
  recipient_signed: 'Signed',
  recipient_approved: 'Approved',
  recipient_declined: 'Declined',
  recipient_corrected: 'Name or email corrected',
  link_reissued: 'New link issued',
  reminder_queued: 'Reminder queued',
  envelope_declined: 'Document stopped: someone declined',
  envelope_voided: 'Document cancelled',
  envelope_expired: 'Document expired',
  sealing_started: 'Sealing started',
  sealing_completed: 'Sealed',
  sealing_failed: 'Sealing failed',
  envelope_completed: 'Completed',
  envelope_filed: 'Filed into a folder by a rule',
  envelope_moved: 'Moved to another folder',
  document_downloaded: 'Completed file downloaded',
  abuse_reported: 'Reported as suspicious',
  abuse_report_closed: 'Report closed by the administrator',
};

/** Steps that are noise for a person reading the history (they stay in the full audit trail and certificate). */
const QUIET = new Set(['email_queued', 'fields_changed', 'document_downloaded']);

export interface TimelineInput {
  event_type: string;
  created_at: string;
  recipient_id: string | null;
}
export interface TimelineItem {
  when: string;
  what: string;
  who: string | null;
}

export function buildTimeline(events: TimelineInput[], names: Map<string, string>, opts: { all?: boolean } = {}): TimelineItem[] {
  return events
    .filter((e) => opts.all || !QUIET.has(e.event_type))
    .map((e) => ({
      when: e.created_at,
      what: LABELS[e.event_type] ?? e.event_type.replace(/_/g, ' '),
      who: e.recipient_id ? (names.get(e.recipient_id) ?? 'A person who is no longer on the document') : null,
    }));
}
