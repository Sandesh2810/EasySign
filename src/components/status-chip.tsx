// Status is always shown as words; colour is a secondary cue only.
const LABEL: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  in_progress: 'In progress',
  completed: 'Completed',
  declined: 'Declined',
  voided: 'Voided',
  expired: 'Expired',
  failed_sealing: 'Needs attention',
};

const TONE: Record<string, string> = {
  completed: 'border-success text-success',
  declined: 'border-danger text-danger',
  voided: 'border-danger text-danger',
  failed_sealing: 'border-danger text-danger',
  expired: 'border-warning text-warning',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-pill border bg-surface px-3 py-0.5 text-sm ${TONE[status] ?? 'border-control-border text-ink-body'}`}>
      {LABEL[status] ?? status}
    </span>
  );
}
