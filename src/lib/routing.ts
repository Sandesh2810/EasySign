// Routing rules for documents with several recipients (DECISIONS D-52). Pure logic: no database, no clock.
// The database functions enforce the same rules; this module is the specification they are tested
// against, and it drives what the screens show ("waiting for Sam", "not your turn yet").
//
// - Signers, in-person signers and approvers must act. CC and viewers never hold anything up.
// - Every recipient has an order number. Equal numbers act at the same time; a higher number waits
//   until every acting recipient with a lower number has finished.
// - A decline stops the document for everyone. When everyone who must act has finished, it is sealed.
// - Signing group (D-81): signers with the same group name share one turn; the first of them to sign completes it,
//   and the others are marked "skipped" (no longer needed). A group counts as one step.

export const ROLES = ['signer', 'approver', 'cc', 'viewer', 'in_person'] as const;
export type Role = (typeof ROLES)[number];
export type RecipientStatus = 'created' | 'sent' | 'viewed' | 'consented' | 'signed' | 'approved' | 'declined' | 'expired' | 'skipped';
export type RoutingMode = 'sequential' | 'parallel' | 'mixed';
export type Action = 'sign' | 'approve' | 'decline';

export interface RoutingRecipient {
  id: string;
  role: Role;
  /** routing_order in the database: 1 or higher */
  order: number;
  status: RecipientStatus;
  /** signing group name (signers only); members share one turn and one of them signs for all (D-81) */
  group?: string | null;
}

export type Effect =
  /** these recipients are now in turn: create their access and tell them */
  | { type: 'activate'; ids: string[] }
  /** everyone who must act has finished: queue sealing (emitted exactly once) */
  | { type: 'seal' }
  /** the document has stopped: revoke every link and tell the sender */
  | { type: 'declined'; by: string };

export type Refusal = 'UNKNOWN' | 'DECLINED' | 'NOT_AN_ACTOR' | 'GROUP_DONE' | 'ALREADY_DONE' | 'CLOSED' | 'NOT_YOUR_TURN' | 'WRONG_ACTION';

export class RoutingError extends Error {
  constructor(
    public readonly code: Refusal,
    message: string,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export const MAX_RECIPIENTS = 20;

/** True for the roles whose action the document waits for. */
export const mustAct = (r: Pick<RoutingRecipient, 'role'>): boolean => r.role === 'signer' || r.role === 'in_person' || r.role === 'approver';

export const isDone = (r: RoutingRecipient): boolean => mustAct(r) && (r.status === 'signed' || r.status === 'approved' || isGroupSkipped(r));
/** A group member who is no longer needed because another member signed (D-81). */
export const isGroupSkipped = (r: RoutingRecipient): boolean => Boolean(r.group) && r.status === 'skipped';

const isWaiting = (r: RoutingRecipient): boolean => r.status === 'created' || r.status === 'sent' || r.status === 'viewed' || r.status === 'consented';

export function outcome(recipients: readonly RoutingRecipient[]): 'open' | 'ready_to_seal' | 'declined' {
  if (recipients.some((r) => r.status === 'declined')) return 'declined';
  return recipients.filter(mustAct).every(isDone) ? 'ready_to_seal' : 'open';
}

/** The order number whose turn it is, or null when nobody is left to act (or the document was declined). */
export function activeOrder(recipients: readonly RoutingRecipient[]): number | null {
  if (outcome(recipients) !== 'open') return null;
  const pending = recipients.filter((r) => mustAct(r) && !isDone(r)).map((r) => r.order);
  return pending.length ? Math.min(...pending) : null;
}

export function canAct(recipients: readonly RoutingRecipient[], id: string): { ok: true } | { ok: false; reason: Exclude<Refusal, 'WRONG_ACTION'> } {
  const r = recipients.find((x) => x.id === id);
  if (!r) return { ok: false, reason: 'UNKNOWN' };
  if (outcome(recipients) === 'declined') return { ok: false, reason: 'DECLINED' };
  if (!mustAct(r)) return { ok: false, reason: 'NOT_AN_ACTOR' };
  if (isGroupSkipped(r)) return { ok: false, reason: 'GROUP_DONE' };
  if (isDone(r)) return { ok: false, reason: 'ALREADY_DONE' };
  if (!isWaiting(r)) return { ok: false, reason: 'CLOSED' };
  if (r.order !== activeOrder(recipients)) return { ok: false, reason: 'NOT_YOUR_TURN' };
  return { ok: true };
}

/** May this person open the document? CC only once it is complete; everyone else once their turn has come. */
export function canView(recipients: readonly RoutingRecipient[], id: string): boolean {
  const r = recipients.find((x) => x.id === id);
  if (!r) return false;
  const state = outcome(recipients);
  if (state === 'declined') return false;
  if (r.role === 'cc') return state === 'ready_to_seal';
  return state === 'ready_to_seal' || (r.status !== 'created' && r.status !== 'skipped' && r.status !== 'expired');
}

/**
 * Bring into turn everyone whose turn has come: acting recipients in the active order, and viewers at
 * or before it. Used when the document is sent and after every action. Marks them "sent".
 */
export function advance(recipients: readonly RoutingRecipient[]): { recipients: RoutingRecipient[]; effects: Effect[] } {
  const active = activeOrder(recipients);
  if (active === null) return { recipients: recipients.map((r) => ({ ...r })), effects: [] };
  const ids: string[] = [];
  const next = recipients.map((r) => {
    const due = r.status === 'created' && ((mustAct(r) && r.order === active) || (r.role === 'viewer' && r.order <= active));
    if (!due) return { ...r };
    ids.push(r.id);
    return { ...r, status: 'sent' as const };
  });
  return { recipients: next, effects: ids.length ? [{ type: 'activate', ids }] : [] };
}

const REFUSAL_TEXT: Record<Exclude<Refusal, 'WRONG_ACTION'>, string> = {
  UNKNOWN: 'This person is not a recipient of the document.',
  DECLINED: 'This document was declined and is closed.',
  NOT_AN_ACTOR: 'This person receives a copy and has nothing to sign.',
  GROUP_DONE: "Someone else in this person's signing group has already signed.",
  ALREADY_DONE: 'This person has already finished.',
  CLOSED: 'This document is no longer open for this person.',
  NOT_YOUR_TURN: 'It is not this person\'s turn yet.',
};

/** Apply one action. Throws RoutingError when the rules do not allow it; never changes its input. */
export function applyAction(recipients: readonly RoutingRecipient[], id: string, action: Action): { recipients: RoutingRecipient[]; effects: Effect[] } {
  const verdict = canAct(recipients, id);
  if (!verdict.ok) throw new RoutingError(verdict.reason, REFUSAL_TEXT[verdict.reason]);
  const actor = recipients.find((r) => r.id === id)!;
  if (actor.role === 'approver' && action === 'sign') throw new RoutingError('WRONG_ACTION', 'An approver can approve or decline.');
  if (actor.role !== 'approver' && action === 'approve') throw new RoutingError('WRONG_ACTION', 'A signer can sign or decline.');

  if (action === 'decline') {
    const closed = recipients.map((r) => {
      if (r.id === id) return { ...r, status: 'declined' as const };
      return r.status === 'signed' || r.status === 'approved' ? { ...r } : { ...r, status: 'skipped' as const };
    });
    return { recipients: closed, effects: [{ type: 'declined', by: id }] };
  }

  // a signing group member signs for the whole group: the other members still waiting are no longer needed
  const acted = recipients.map((r) => {
    if (r.id === id) return { ...r, status: action === 'approve' ? ('approved' as const) : ('signed' as const) };
    if (actor.group && r.group === actor.group && isWaiting(r)) return { ...r, status: 'skipped' as const };
    return { ...r };
  });
  if (outcome(acted) === 'ready_to_seal') return { recipients: acted, effects: [{ type: 'seal' }] };
  return advance(acted);
}

/** Order numbers for the two presets, given the recipients' roles in list order. */
export function assignOrders(mode: 'sequential' | 'parallel', roles: readonly Role[], groups: readonly (string | null | undefined)[] = []): number[] {
  if (mode === 'parallel') return roles.map(() => 1);
  let turn = 0;
  const groupTurn = new Map<string, number>(); // D-81: a signing group takes one turn, at its first member's place
  return roles.map((role, i) => {
    const g = role === 'signer' ? groups[i]?.trim().toLowerCase() : '';
    if (g && groupTurn.has(g)) return groupTurn.get(g)!;
    if (mustAct({ role })) turn++;
    if (g) groupTurn.set(g, Math.max(turn, 1));
    return Math.max(turn, 1); // CC and viewers ride along with the acting person before them
  });
}

export type RoutingProblem = 'NO_SIGNER' | 'TOO_MANY' | 'DUPLICATE_ID' | 'BAD_ORDER' | 'SEQUENTIAL_TIE' | 'PARALLEL_SPLIT' | 'GROUP';

export function validateRouting(recipients: readonly RoutingRecipient[], mode: RoutingMode): { ok: true } | { ok: false; code: RoutingProblem; message: string } {
  const bad = (code: RoutingProblem, message: string) => ({ ok: false as const, code, message });
  if (!recipients.some((r) => r.role === 'signer' || r.role === 'in_person')) return bad('NO_SIGNER', 'Add at least one person who signs.');
  if (recipients.length > MAX_RECIPIENTS) return bad('TOO_MANY', `A document can have up to ${MAX_RECIPIENTS} recipients.`);
  if (new Set(recipients.map((r) => r.id)).size !== recipients.length) return bad('DUPLICATE_ID', 'A recipient is listed twice.');
  if (recipients.some((r) => !Number.isInteger(r.order) || r.order < 1 || r.order > 99)) return bad('BAD_ORDER', 'Signing order must be a whole number from 1 to 99.');
  const groups = new Map<string, RoutingRecipient[]>();
  for (const r of recipients) {
    const g = r.group?.trim();
    if (!g) continue;
    if (g.length > 60) return bad('GROUP', 'A signing group name can be up to 60 characters.');
    groups.set(g.toLowerCase(), [...(groups.get(g.toLowerCase()) ?? []), r]);
  }
  for (const [, members] of groups) {
    const label = members[0].group!.trim();
    if (members.some((m) => m.role !== 'signer')) return bad('GROUP', `Only people who sign can be in a signing group ("${label}").`);
    if (members.length < 2) return bad('GROUP', `The signing group "${label}" needs at least two people.`);
    if (new Set(members.map((m) => m.order)).size > 1) return bad('GROUP', `Everyone in the signing group "${label}" must have the same place in the order.`);
  }
  // a signing group takes one turn, like one person
  const units = new Map<string, number>();
  for (const r of recipients.filter(mustAct)) units.set(r.group?.trim() ? `g:${r.group.trim().toLowerCase()}` : `r:${r.id}`, r.order);
  const acting = [...units.values()];
  if (mode === 'sequential' && new Set(acting).size !== acting.length) return bad('SEQUENTIAL_TIE', 'In "one after another" each person who signs or approves needs their own place in the order.');
  if (mode === 'parallel' && new Set(acting).size > 1) return bad('PARALLEL_SPLIT', 'In "all at once" everyone who signs or approves shares the same place in the order.');
  return { ok: true };
}
