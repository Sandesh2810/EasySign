// Signing groups (Phase 4 slice 6, AT4.5, D-81): the sender places the group's fields once; every member gets the same
// copy, so whichever member signs first completes the group with their own answers (members never overwrite each
// other). The first member (by turn, then creation) stands for the group in the field editor. No server-only imports.

export interface GroupMember {
  id: string;
  signing_group?: string | null;
  routing_order?: number | null;
  created_at?: string | null;
}

const keyOf = (g: string | null | undefined) => (g ?? '').trim().toLowerCase();

function ordered<T extends GroupMember>(rs: readonly T[]): T[] {
  return [...rs].sort(
    (a, b) => (a.routing_order ?? 0) - (b.routing_order ?? 0) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id),
  );
}

/** Each signing group's members, first member first, keyed by the group name without case. */
export function groupsOf<T extends GroupMember>(rs: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of ordered(rs)) {
    const k = keyOf(r.signing_group);
    if (k) out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

/**
 * member id -> the id of the member who stands for their group: the first member who has fields (so fields the sender
 * placed are never thrown away, whoever they were placed for), else the first member. People added in one save share a
 * creation time, so "first" alone can fall either way.
 */
export function representatives(rs: readonly GroupMember[], fields: readonly { recipient_id: string }[] = []): Map<string, string> {
  const withFields = new Set(fields.map((f) => f.recipient_id));
  const out = new Map<string, string>();
  for (const members of groupsOf(rs).values()) {
    const rep = (members.find((m) => withFields.has(m.id)) ?? members[0]).id;
    for (const m of members) out.set(m.id, rep);
  }
  return out;
}

/**
 * The layout every member should have: fields of people outside groups and of each group's first member are kept;
 * every other member's fields are replaced by copies of their first member's fields.
 */
export function mirrorGroupFields<F extends { recipient_id: string }>(fields: readonly F[], rs: readonly GroupMember[]): F[] {
  const rep = representatives(rs, fields);
  const kept = fields.filter((f) => (rep.get(f.recipient_id) ?? f.recipient_id) === f.recipient_id);
  const copies: F[] = [];
  for (const [member, first] of rep) {
    if (member === first) continue;
    for (const f of kept) if (f.recipient_id === first) copies.push({ ...f, recipient_id: member });
  }
  return [...kept, ...copies];
}
