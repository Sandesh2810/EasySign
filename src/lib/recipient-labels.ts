// Plain-language labels for roles and progress. Shared by sender screens and the signing page.
import type { RecipientStatus, Role } from './routing';

export const ROLE_LABEL: Record<Role, string> = {
  signer: 'Signs',
  in_person: 'Signs in person',
  approver: 'Approves',
  viewer: 'Can read it',
  cc: 'Gets a copy at the end',
};

/** What the sender sees next to each person once the document has been sent. */
export function progressLabel(role: Role, status: RecipientStatus): string {
  if (role === 'cc') return status === 'skipped' ? 'No copy (document stopped)' : 'Gets the finished copy';
  switch (status) {
    case 'created':
      return role === 'viewer' ? 'Not shown yet' : 'Waiting for their turn';
    case 'sent':
      return role === 'viewer' ? 'Can open it now' : 'Their turn: not opened yet';
    case 'viewed':
      return role === 'viewer' ? 'Opened' : 'Their turn: opened';
    case 'consented':
      return 'Their turn: in progress';
    case 'signed':
      return 'Signed';
    case 'approved':
      return 'Approved';
    case 'declined':
      return 'Declined';
    case 'skipped':
      return 'Not needed (document stopped)';
    case 'expired':
      return 'Expired';
  }
}
