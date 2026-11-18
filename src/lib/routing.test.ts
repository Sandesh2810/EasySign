import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  activeOrder,
  advance,
  applyAction,
  assignOrders,
  canAct,
  canView,
  isDone,
  mustAct,
  outcome,
  RoutingError,
  validateRouting,
  type Action,
  type Effect,
  type Role,
  type RoutingRecipient,
} from './routing';

const R = (id: string, role: Role, order: number): RoutingRecipient => ({ id, role, order, status: 'created' });
const actionFor = (r: RoutingRecipient): Action => (r.role === 'approver' ? 'approve' : 'sign');

/** Random recipient lists: 1–8 people, orders 1–4, always at least one signer. */
const recipientsArb = fc
  .array(fc.record({ role: fc.constantFrom<Role>('signer', 'signer', 'approver', 'cc', 'viewer', 'in_person'), order: fc.integer({ min: 1, max: 4 }) }), { minLength: 1, maxLength: 8 })
  .map((list) => list.map((x, i) => R(`r${i}`, i === 0 ? 'signer' : x.role, x.order)));

/** Plays a document to the end, choosing among the people allowed to act with the supplied picks. */
function play(start: RoutingRecipient[], picks: number[], declineAtStep = -1) {
  const first = advance(start);
  let rs = first.recipients;
  const effects: Effect[] = [...first.effects];
  const activeOrders: number[] = [];
  let steps = 0;
  while (outcome(rs) === 'open') {
    const allowed = rs.filter((r) => canAct(rs, r.id).ok);
    if (allowed.length === 0) throw new Error('stuck: document is open but nobody may act');
    activeOrders.push(activeOrder(rs)!);
    const who = allowed[(picks[steps] ?? 0) % allowed.length];
    const res = applyAction(rs, who.id, steps === declineAtStep ? 'decline' : actionFor(who));
    rs = res.recipients;
    effects.push(...res.effects);
    steps++;
    if (steps > 100) throw new Error('runaway');
  }
  return { rs, effects, steps, activeOrders };
}
const picksArb = fc.array(fc.nat(50), { minLength: 0, maxLength: 16 });

describe('routing: worked examples', () => {
  it('one after another: only the first signer may act, then the second', () => {
    let rs = advance([R('a', 'signer', 1), R('b', 'signer', 2)]).recipients;
    expect(canAct(rs, 'a')).toEqual({ ok: true });
    expect(canAct(rs, 'b')).toEqual({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(() => applyAction(rs, 'b', 'sign')).toThrow(RoutingError);
    const step = applyAction(rs, 'a', 'sign');
    rs = step.recipients;
    expect(step.effects).toEqual([{ type: 'activate', ids: ['b'] }]);
    expect(canAct(rs, 'a')).toEqual({ ok: false, reason: 'ALREADY_DONE' });
    expect(canAct(rs, 'b')).toEqual({ ok: true });
    expect(applyAction(rs, 'b', 'sign').effects).toEqual([{ type: 'seal' }]);
  });

  it('all at once: everyone may act from the start, in any order', () => {
    const rs = advance([R('a', 'signer', 1), R('b', 'signer', 1), R('c', 'in_person', 1)]);
    expect(rs.effects).toEqual([{ type: 'activate', ids: ['a', 'b', 'c'] }]);
    expect(['a', 'b', 'c'].every((id) => canAct(rs.recipients, id).ok)).toBe(true);
  });

  it('approver gate: the signer waits until the approver approves', () => {
    let rs = advance([R('boss', 'approver', 1), R('sam', 'signer', 2)]).recipients;
    expect(canAct(rs, 'sam')).toEqual({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(() => applyAction(rs, 'boss', 'sign')).toThrow(/approve/);
    rs = applyAction(rs, 'boss', 'approve').recipients;
    expect(rs.find((r) => r.id === 'boss')!.status).toBe('approved');
    expect(canAct(rs, 'sam')).toEqual({ ok: true });
    expect(() => applyAction(rs, 'sam', 'approve')).toThrow(/sign/);
  });

  it('CC never acts, never holds things up, and is not contacted before completion', () => {
    const start = advance([R('cc', 'cc', 1), R('sam', 'signer', 2)]);
    expect(start.effects).toEqual([{ type: 'activate', ids: ['sam'] }]);
    expect(canAct(start.recipients, 'cc')).toEqual({ ok: false, reason: 'NOT_AN_ACTOR' });
    expect(canView(start.recipients, 'cc')).toBe(false);
    const done = applyAction(start.recipients, 'sam', 'sign');
    expect(done.effects).toEqual([{ type: 'seal' }]);
    expect(done.recipients.find((r) => r.id === 'cc')!.status).toBe('created');
  });

  it('a viewer may read once their turn comes, without holding anyone up', () => {
    let rs = advance([R('a', 'signer', 1), R('v', 'viewer', 2), R('b', 'signer', 2)]).recipients;
    expect(canView(rs, 'v')).toBe(false);
    const step = applyAction(rs, 'a', 'sign');
    rs = step.recipients;
    expect(step.effects).toEqual([{ type: 'activate', ids: ['v', 'b'] }]);
    expect(canView(rs, 'v')).toBe(true);
    expect(applyAction(rs, 'b', 'sign').effects).toEqual([{ type: 'seal' }]);
  });

  it('a decline stops the document for everyone', () => {
    let rs = advance([R('a', 'signer', 1), R('b', 'signer', 1), R('c', 'signer', 2)]).recipients;
    rs = applyAction(rs, 'a', 'sign').recipients;
    const res = applyAction(rs, 'b', 'decline');
    expect(res.effects).toEqual([{ type: 'declined', by: 'b' }]);
    expect(outcome(res.recipients)).toBe('declined');
    expect(res.recipients.map((r) => r.status)).toEqual(['signed', 'declined', 'skipped']);
    expect(canAct(res.recipients, 'c')).toEqual({ ok: false, reason: 'DECLINED' });
    expect(() => applyAction(res.recipients, 'c', 'sign')).toThrow(RoutingError);
  });

  it('unknown people cannot act', () => {
    const rs = advance([R('a', 'signer', 1)]).recipients;
    expect(canAct(rs, 'nobody')).toEqual({ ok: false, reason: 'UNKNOWN' });
  });
});

describe('routing: properties over random recipient lists', () => {
  it('nobody acts out of turn: whoever may act is in the lowest unfinished order, and everyone before them has finished', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, (start, picks) => {
        let rs = advance(start).recipients;
        let steps = 0;
        while (outcome(rs) === 'open') {
          const active = activeOrder(rs)!;
          for (const r of rs) {
            const verdict = canAct(rs, r.id);
            if (verdict.ok) {
              expect(mustAct(r)).toBe(true);
              expect(r.order).toBe(active);
              expect(rs.filter((x) => mustAct(x) && x.order < r.order).every(isDone)).toBe(true);
            } else {
              expect(() => applyAction(rs, r.id, actionFor(r))).toThrow(RoutingError);
            }
          }
          const allowed = rs.filter((r) => canAct(rs, r.id).ok);
          const who = allowed[(picks[steps] ?? 0) % allowed.length];
          rs = applyAction(rs, who.id, actionFor(who)).recipients;
          steps++;
        }
      }),
    );
  });

  it('without a decline the document completes after exactly one action per acting person, and sealing is requested exactly once, last', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, (start, picks) => {
        const run = play(start, picks);
        expect(outcome(run.rs)).toBe('ready_to_seal');
        expect(run.steps).toBe(start.filter(mustAct).length);
        expect(run.effects.filter((e) => e.type === 'seal')).toHaveLength(1);
        expect(run.effects.at(-1)).toEqual({ type: 'seal' });
        expect(run.rs.filter(mustAct).every(isDone)).toBe(true);
      }),
    );
  });

  it('the active order never goes backwards', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, (start, picks) => {
        const { activeOrders } = play(start, picks);
        for (let i = 1; i < activeOrders.length; i++) expect(activeOrders[i]).toBeGreaterThanOrEqual(activeOrders[i - 1]);
      }),
    );
  });

  it('CC and viewers make no difference to who must act or how many steps it takes', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, (start, picks) => {
        const withAll = play(start, picks);
        const actorsOnly = play(start.filter(mustAct), picks);
        expect(actorsOnly.steps).toBe(withAll.steps);
        expect(actorsOnly.activeOrders).toEqual(withAll.activeOrders);
      }),
    );
  });

  it('the order in which people in the same group act does not change the result', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, picksArb, (start, picksA, picksB) => {
        expect(play(start, picksA).rs).toEqual(play(start, picksB).rs);
      }),
    );
  });

  it('everyone is contacted at most once, acting people before they act, and CC never before completion', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, (start, picks) => {
        const run = play(start, picks);
        const activated = run.effects.flatMap((e) => (e.type === 'activate' ? e.ids : []));
        expect(new Set(activated).size).toBe(activated.length);
        for (const r of start) {
          if (mustAct(r)) expect(activated).toContain(r.id);
          if (r.role === 'cc') expect(activated).not.toContain(r.id);
        }
      }),
    );
  });

  it('a decline at any point is final: nothing is sealed, nobody can act afterwards, and nobody is left waiting', () => {
    fc.assert(
      fc.property(recipientsArb, picksArb, fc.nat(7), (start, picks, at) => {
        const declineAt = at % start.filter(mustAct).length;
        const run = play(start, picks, declineAt);
        expect(outcome(run.rs)).toBe('declined');
        expect(run.effects.filter((e) => e.type === 'seal')).toHaveLength(0);
        expect(run.effects.filter((e) => e.type === 'declined')).toHaveLength(1);
        expect(run.rs.filter((r) => r.status === 'declined')).toHaveLength(1);
        for (const r of run.rs) {
          expect(canAct(run.rs, r.id).ok).toBe(false);
          expect(() => applyAction(run.rs, r.id, actionFor(r))).toThrow(RoutingError);
          if (mustAct(r)) expect(['signed', 'approved', 'declined', 'skipped']).toContain(r.status);
        }
      }),
    );
  });

  it('inputs are never changed in place', () => {
    fc.assert(
      fc.property(recipientsArb, (start) => {
        const before = JSON.stringify(start);
        const first = advance(start);
        const someone = first.recipients.find((r) => canAct(first.recipients, r.id).ok)!;
        const frozen = JSON.stringify(first.recipients);
        applyAction(first.recipients, someone.id, actionFor(someone));
        expect(JSON.stringify(start)).toBe(before);
        expect(JSON.stringify(first.recipients)).toBe(frozen);
      }),
    );
  });
});

describe('routing: presets and validation', () => {
  const roles: Role[] = ['signer', 'cc', 'approver', 'signer', 'viewer'];

  it('"one after another" gives each acting person their own turn, in list order; others ride along with the person before them', () => {
    expect(assignOrders('sequential', roles)).toEqual([1, 1, 2, 3, 3]);
  });

  it('"all at once" puts everyone in the same turn', () => {
    expect(assignOrders('parallel', roles)).toEqual([1, 1, 1, 1, 1]);
  });

  it('presets always pass validation and behave as named', () => {
    fc.assert(
      fc.property(recipientsArb, (list) => {
        const seq = list.map((r, i) => ({ ...r, order: assignOrders('sequential', list.map((x) => x.role))[i] }));
        expect(validateRouting(seq, 'sequential')).toEqual({ ok: true });
        let rs = advance(seq).recipients;
        while (outcome(rs) === 'open') {
          const allowed = rs.filter((r) => canAct(rs, r.id).ok);
          expect(allowed).toHaveLength(1);
          rs = applyAction(rs, allowed[0].id, actionFor(allowed[0])).recipients;
        }
        const par = list.map((r) => ({ ...r, order: 1 }));
        expect(validateRouting(par, 'parallel')).toEqual({ ok: true });
        const open = advance(par).recipients;
        expect(open.filter((r) => canAct(open, r.id).ok)).toHaveLength(par.filter(mustAct).length);
      }),
    );
  });

  it('refuses a document nobody signs, bad order numbers, too many people, and presets that do not match their name', () => {
    expect(validateRouting([R('a', 'approver', 1), R('c', 'cc', 1)], 'mixed')).toMatchObject({ ok: false, code: 'NO_SIGNER' });
    expect(validateRouting([], 'mixed')).toMatchObject({ ok: false, code: 'NO_SIGNER' });
    expect(validateRouting([R('a', 'signer', 0)], 'mixed')).toMatchObject({ ok: false, code: 'BAD_ORDER' });
    expect(validateRouting([R('a', 'signer', 1.5)], 'mixed')).toMatchObject({ ok: false, code: 'BAD_ORDER' });
    expect(validateRouting([R('a', 'signer', 1), R('b', 'signer', 1)], 'sequential')).toMatchObject({ ok: false, code: 'SEQUENTIAL_TIE' });
    expect(validateRouting([R('a', 'signer', 1), R('b', 'signer', 2)], 'parallel')).toMatchObject({ ok: false, code: 'PARALLEL_SPLIT' });
    expect(validateRouting([R('a', 'signer', 1), R('a', 'signer', 2)], 'mixed')).toMatchObject({ ok: false, code: 'DUPLICATE_ID' });
    const many = Array.from({ length: 21 }, (_, i) => R(`r${i}`, 'signer', i + 1));
    expect(validateRouting(many, 'mixed')).toMatchObject({ ok: false, code: 'TOO_MANY' });
    expect(validateRouting([R('a', 'signer', 1), R('b', 'approver', 1), R('c', 'cc', 9)], 'mixed')).toEqual({ ok: true });
  });
});
