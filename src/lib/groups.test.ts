// Signing groups: one layout for every member (Phase 4 slice 6, D-81).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { groupsOf, mirrorGroupFields, representatives } from './groups';

const people = [
  { id: 'cy', signing_group: null, routing_order: 2, created_at: '2026-01-01T00:00:03Z' },
  { id: 'ben', signing_group: ' finance', routing_order: 1, created_at: '2026-01-01T00:00:02Z' },
  { id: 'ann', signing_group: 'Finance', routing_order: 1, created_at: '2026-01-01T00:00:01Z' },
];

describe('signing group layout', () => {
  it('the first member by turn, then creation, stands for the group (names compared without case and spaces)', () => {
    expect([...groupsOf(people).keys()]).toEqual(['finance']);
    expect(groupsOf(people).get('finance')!.map((m) => m.id)).toEqual(['ann', 'ben']);
    expect(Object.fromEntries(representatives(people))).toEqual({ ann: 'ann', ben: 'ann' });
  });
  it("every member gets the first member's fields; a member's own fields are replaced; others are untouched", () => {
    const fields = [
      { recipient_id: 'ann', type: 'signature', y: 0.8 },
      { recipient_id: 'ann', type: 'text', y: 0.2 },
      { recipient_id: 'ben', type: 'date_signed', y: 0.5 }, // left over from before Ben joined the group
      { recipient_id: 'cy', type: 'signature', y: 0.9 },
    ];
    expect(mirrorGroupFields(fields, people)).toEqual([
      { recipient_id: 'ann', type: 'signature', y: 0.8 },
      { recipient_id: 'ann', type: 'text', y: 0.2 },
      { recipient_id: 'cy', type: 'signature', y: 0.9 },
      { recipient_id: 'ben', type: 'signature', y: 0.8 },
      { recipient_id: 'ben', type: 'text', y: 0.2 },
    ]);
  });
  it('the member who has fields stands for the group, so placed fields are never lost (people saved together share a creation time)', () => {
    const tied = [
      { id: 'zed', signing_group: 'F', routing_order: 1, created_at: '2026-01-01T00:00:00Z' },
      { id: 'amy', signing_group: 'F', routing_order: 1, created_at: '2026-01-01T00:00:00Z' },
    ];
    expect(Object.fromEntries(representatives(tied))).toEqual({ amy: 'amy', zed: 'amy' }); // no fields: first by id
    const placedForZed = [{ recipient_id: 'zed', type: 'signature' }];
    expect(Object.fromEntries(representatives(tied, placedForZed))).toEqual({ amy: 'zed', zed: 'zed' });
    expect(mirrorGroupFields(placedForZed, tied)).toEqual([
      { recipient_id: 'zed', type: 'signature' },
      { recipient_id: 'amy', type: 'signature' },
    ]);
  });
  it('without groups nothing changes', () => {
    const fields = [{ recipient_id: 'cy', type: 'signature' }];
    expect(mirrorGroupFields(fields, [{ id: 'cy' }])).toEqual(fields);
  });
  it('property: after mirroring, every member of a group has exactly the same fields as the first member, and doing it twice changes nothing', () => {
    const rec = fc.record({ id: fc.constantFrom('a', 'b', 'c', 'd', 'e'), signing_group: fc.constantFrom(null, 'g1', 'G1', 'g2'), routing_order: fc.integer({ min: 1, max: 2 }) });
    fc.assert(
      fc.property(fc.uniqueArray(rec, { selector: (r) => r.id, maxLength: 5 }), fc.array(fc.record({ recipient_id: fc.constantFrom('a', 'b', 'c', 'd', 'e'), n: fc.nat(9) }), { maxLength: 12 }), (rs, fields) => {
        const known = fields.filter((f) => rs.some((r) => r.id === f.recipient_id));
        const once = mirrorGroupFields(known, rs);
        const twice = mirrorGroupFields(once, rs);
        expect(new Set(twice.map((f) => JSON.stringify(f)))).toEqual(new Set(once.map((f) => JSON.stringify(f))));
        expect(twice.length).toBe(once.length);
        for (const members of groupsOf(rs).values()) {
          const layout = (id: string) => once.filter((f) => f.recipient_id === id).map((f) => f.n).sort().join(',');
          for (const m of members) expect(layout(m.id)).toBe(layout(members[0].id));
        }
      }),
      { numRuns: 500 },
    );
  });
});
