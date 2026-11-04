/**
 * The order an accepted plan is written in (services/day-replan/sequence.js): each visit's new hours are free at
 * its step, a swap or cycle is broken through a temporary hour, and a temporary hour is never the final state.
 */
const { sequenceMoves, hoursMask } = require('../services/day-replan/sequence');

const H = (h) => h * 60;
const options = { openMin: H(8), closeMin: H(17), blocks: [] };
const move = (id, from, to, extra = {}) => ({ id, fromStart: H(from), toStart: H(to), widthMin: 60, workMin: 30, pref: null, ...extra });
const mask = (...hours) => hours.reduce((m, h) => m | (1 << h), 0);

/** Replays the steps against the occupancy rule and checks the end state. */
function replay(moves, heldMask, steps) {
  const here = new Map(moves.map((m) => [m.id, m.fromStart]));
  const widthOf = new Map(moves.map((m) => [m.id, m.widthMin]));
  for (const step of steps) {
    const others = moves.reduce((m, o) => (o.id === step.id ? m : m | hoursMask(here.get(o.id), widthOf.get(o.id))), heldMask);
    expect(hoursMask(step.toStart, widthOf.get(step.id)) & others).toBe(0);
    here.set(step.id, step.toStart);
  }
  for (const m of moves) expect(here.get(m.id)).toBe(m.toStart);
}

describe('sequenceMoves', () => {
  test('moves into free hours straight, in id order, with no temporary hour', () => {
    const moves = [move('b', 9, 12), move('a', 8, 13)];
    const held = mask(10);
    const steps = sequenceMoves({ moves, heldMask: held, options });
    expect(steps).toEqual([{ id: 'a', toStart: H(13), temp: false }, { id: 'b', toStart: H(12), temp: false }]);
  });

  test('a visit waits until the hour it needs has been vacated', () => {
    // b needs hour 8, which a holds until a moves on to hour 12.
    const moves = [move('a', 8, 12), move('b', 9, 8)];
    const steps = sequenceMoves({ moves, heldMask: 0, options });
    expect(steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(steps.every((s) => !s.temp)).toBe(true);
    replay(moves, 0, steps);
  });

  test('a swap goes through a temporary hour that is free, and ends on the planned hours', () => {
    const moves = [move('a', 8, 9), move('b', 9, 8)];
    const steps = sequenceMoves({ moves, heldMask: 0, options });
    expect(steps.filter((s) => s.temp)).toHaveLength(1);
    const temp = steps.find((s) => s.temp);
    expect([H(8), H(9)]).not.toContain(temp.toStart);
    expect(temp.toStart).toBeGreaterThanOrEqual(H(8));
    expect(temp.toStart + 60).toBeLessThanOrEqual(H(17));
    replay(moves, 0, steps);
    // The temporary hour is never final: each visit's last step lands its planned hour.
    for (const m of moves) expect(steps.filter((s) => s.id === m.id).at(-1).toStart).toBe(m.toStart);
  });

  test('a three-visit cycle needs one temporary hour', () => {
    const moves = [move('a', 8, 9), move('b', 9, 10), move('c', 10, 8)];
    const steps = sequenceMoves({ moves, heldMask: 0, options });
    expect(steps.filter((s) => s.temp)).toHaveLength(1);
    replay(moves, 0, steps);
  });

  test('no free temporary hour means no safe sequence', () => {
    // Nine one-hour hours (8-16), all held: two visits swap and every other hour is held by a fixed stop.
    const moves = [move('a', 8, 9), move('b', 9, 8)];
    const held = mask(10, 11, 12, 13, 14, 15, 16);
    expect(sequenceMoves({ moves, heldMask: held, options })).toBeNull();
  });

  test('a temporary hour must satisfy the visit\'s time preference and clear the schedule blocks', () => {
    const swap = (extra, opts = options) => sequenceMoves({
      moves: [move('a', 8, 9, extra), move('b', 9, 8)], heldMask: mask(11, 12, 13, 14, 15, 16), options: opts,
    });
    // Free hours left: 10 only. A preference for the afternoon rules it out for a; b has none, so b is parked there.
    const parkedB = swap({ pref: { startMin: H(13), endMin: H(15) } });
    expect(parkedB.find((s) => s.temp).id).toBe('b');
    // A lunch block over hour 10 (b's 30 minutes of work would run into it) removes the last free hour for both.
    expect(swap({}, { ...options, blocks: [{ startMin: H(10), endMin: H(11) }] })).toBeNull();
  });

  test('a temporary hour stays inside the day', () => {
    // Only hour 17 is free, and a one-hour window starting at 17:00 ends after the 17:00 close.
    const moves = [move('a', 8, 9), move('b', 9, 8)];
    const held = mask(10, 11, 12, 13, 14, 15, 16);
    expect(sequenceMoves({ moves, heldMask: held, options: { ...options, closeMin: H(17) } })).toBeNull();
    // With a later close the same day has room.
    expect(sequenceMoves({ moves, heldMask: held, options: { ...options, closeMin: H(18) } })).not.toBeNull();
  });

  test('a two-hour visit needs both of its hours free at its step', () => {
    const moves = [move('w', 8, 10, { widthMin: 120 }), move('x', 10, 8)];
    // w's new hours 10-11 are held by x until x moves to 8, which w holds: a swap of unequal widths.
    const steps = sequenceMoves({ moves, heldMask: 0, options });
    expect(steps).not.toBeNull();
    replay(moves, 0, steps);
  });

  test('is deterministic', () => {
    const moves = [move('a', 8, 9), move('b', 9, 10), move('c', 10, 8)];
    expect(sequenceMoves({ moves, heldMask: 0, options })).toEqual(sequenceMoves({ moves: [...moves].reverse(), heldMask: 0, options }));
  });
});
