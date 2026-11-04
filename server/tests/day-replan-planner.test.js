/**
 * Day re-plan planner (services/day-replan/planner.js): pure and deterministic.
 * Points sit on a flat plane where one unit is one minute of driving, so every expected number
 * can be checked by hand.
 */
const { planDay } = require('../services/day-replan/planner');

const legMin = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng));
const origin = { lat: 0, lng: 0 };

function stop(id, x, hour, extra = {}) {
  return {
    id, lat: x, lng: 0, slotStartMin: hour * 60, slotWidthMin: 60, workMin: 30, movable: true, pref: null, ...extra,
  };
}

function input(stops, extra = {}) {
  return { stops, origin, departureMin: 8 * 60, legMin, options: {}, ...extra };
}

// A zigzag day: the van goes far, near, far, near.
function zigzag(extra = {}) {
  return [stop('p1', 40, 8, extra), stop('p2', 5, 9, extra), stop('p3', 45, 10, extra), stop('p4', 10, 11, extra)];
}

/** Replays the best plan by hand and checks every rule the planner promises. */
function replayAndCheck(inp, result, { promise = 120, margin = 15 } = {}) {
  expect(result.best).not.toBeNull();
  const byId = new Map(inp.stops.map((s) => [s.id, s]));
  const held = (slot, width) => {
    const first = Math.floor(slot / 60);
    const last = Math.max(first, Math.ceil((slot + width) / 60) - 1);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  };
  const fixedHours = new Set(inp.stops.filter((s) => !s.movable).flatMap((s) => held(s.slotStartMin, s.slotWidthMin)));
  const movableHours = [];
  let t = inp.departureMin;
  let prev = inp.origin;
  let drive = 0;
  expect(result.best.order).toHaveLength(inp.stops.length);
  for (const id of result.best.order) {
    const s = byId.get(id);
    const d = inp.legMin(prev, s);
    drive += d;
    t += d;
    const slot = result.best.slots[id];
    expect(t).toBeLessThanOrEqual(slot + promise - margin);
    if (s.movable) {
      expect(slot % 60).toBe(0);
      expect(slot / 60).toBeGreaterThanOrEqual(8);
      expect(slot / 60).toBeLessThanOrEqual(17);
      if (s.pref) {
        expect(slot).toBeGreaterThanOrEqual(s.pref.startMin);
        expect(slot).toBeLessThan(s.pref.endMin);
      }
      movableHours.push(...held(slot, s.slotWidthMin));
    } else {
      expect(slot).toBe(s.slotStartMin);
    }
    t = Math.max(t, slot) + s.workMin;
    prev = s;
  }
  drive += inp.legMin(prev, inp.origin);
  expect(drive).toBe(result.best.driveMin);
  expect(t).toBe(result.best.endMin);
  expect(t).toBeLessThanOrEqual(result.current.endMin);
  expect(new Set(movableHours).size).toBe(movableHours.length);
  for (const h of movableHours) expect(fixedHours.has(h)).toBe(false);
}

describe('current plan', () => {
  test('is every stop at its slot, in slot order, with lateness reported', () => {
    const late = [stop('a', 120, 8), stop('b', 0, 9)];
    const r = planDay(input(late));
    expect(r.current.order).toEqual(['a', 'b']);
    expect(r.current.slots).toEqual({ a: 480, b: 540 });
    // 120 minutes of driving reaches a at 10:00; the bound is 08:00 + 105 min = 09:45, so it is 15 min late.
    // b is reached at 12:30 against a 10:45 bound.
    expect(r.current.late).toEqual([{ id: 'a', lateMin: 15 }, { id: 'b', lateMin: 105 }]);
    expect(r.current.driveMin).toBe(120 + 120 + 0);
  });

  test('ties in the slot keep the caller order', () => {
    const r = planDay(input([stop('z', 10, 9), stop('a', 20, 9)]));
    expect(r.current.order).toEqual(['z', 'a']);
  });
});

describe('search', () => {
  test('a zigzag day gets a shorter order with new hours', () => {
    const inp = input(zigzag());
    const r = planDay(inp);
    expect(r.current.driveMin).toBe(160);
    expect(r.best.driveMin).toBe(90);
    expect(r.savedMin).toBe(70);
    expect(r.accepted).toBe(true);
    expect(r.reason).toBe('accepted');
    // Out to the far end first, then back past the near stops; three equal-drive orders exist and this one
    // changes the fewest hours (only p2, p3 and p4 move).
    expect(r.best.order).toEqual(['p1', 'p3', 'p4', 'p2']);
    expect(r.best.slots).toEqual({ p1: 480, p3: 540, p4: 600, p2: 660 });
    expect(r.changes).toEqual([
      { id: 'p2', fromMin: 540, toMin: 660 },
      { id: 'p3', fromMin: 600, toMin: 540 },
      { id: 'p4', fromMin: 660, toMin: 600 },
    ]);
    for (const c of r.changes) expect(c.toMin).not.toBe(c.fromMin);
    replayAndCheck(inp, r);
  });

  test('the van waits for a later hour instead of arriving before it', () => {
    // Everything is next to the origin, so the first stop is reached at 08:05 and the second at 08:40.
    const inp = input([stop('a', 5, 8, { workMin: 30 }), stop('b', 6, 9, { workMin: 30 })]);
    const r = planDay(inp);
    replayAndCheck(inp, r);
    expect(new Set(Object.values(r.best.slots)).size).toBe(2);
  });

  test('a fixed stop keeps its hour and its arrival bound', () => {
    const stops = zigzag();
    stops[2] = { ...stops[2], movable: false }; // p3 stays at 10:00
    const inp = input(stops);
    const r = planDay(inp);
    expect(r.best.slots.p3).toBe(10 * 60);
    replayAndCheck(inp, r);
    // No movable stop takes the fixed stop's hour.
    for (const id of ['p1', 'p2', 'p4']) expect(r.best.slots[id]).not.toBe(10 * 60);
  });

  test('a fixed stop that could only be reached after its bound makes that order infeasible', () => {
    // F is 100 min out and fixed at 08:00: the van must leave for it first (bound 09:45), not last.
    const stops = [
      stop('f', 100, 8, { movable: false }),
      stop('m1', 1, 9),
      stop('m2', 2, 10),
    ];
    const inp = input(stops);
    const r = planDay(inp);
    expect(r.best.order[0]).toBe('f');
    replayAndCheck(inp, r);
  });

  test('only one movable stop takes an hour, and fixed stops may share an hour', () => {
    const stops = [
      stop('f1', 10, 9, { movable: false }),
      stop('f2', 11, 9, { movable: false }),
      stop('m1', 12, 10),
      stop('m2', 13, 11),
      stop('m3', 14, 12),
    ];
    const inp = input(stops);
    const r = planDay(inp);
    expect(r.best.slots.f1).toBe(540);
    expect(r.best.slots.f2).toBe(540);
    replayAndCheck(inp, r);
  });

  test('an explicit preferred time window is a hard filter', () => {
    const stops = zigzag();
    stops[1] = { ...stops[1], pref: { startMin: 11 * 60, endMin: 12 * 60 } };
    const inp = input(stops);
    const r = planDay(inp);
    expect(r.best.slots.p2).toBe(11 * 60);
    replayAndCheck(inp, r);
  });

  test('the arrival margin counts: a stop reached inside the margin is not allowed', () => {
    // 108 min out, fixed at 08:00, van leaves 08:00: arrives 09:48, past the 09:45 bound but inside 10:00.
    const inp = input([stop('f', 108, 8, { movable: false, workMin: 10 })]);
    expect(planDay(inp).reason).toBe('no_feasible_order');
    expect(planDay(inp).best).toBeNull();
    const lenient = planDay({ ...inp, options: { marginMin: 0 } });
    expect(lenient.best).not.toBeNull();
    expect(lenient.reason).toBe('saving_below_floor');
  });

  test('a re-planned day never ends later than today', () => {
    const rnd = mulberry(7);
    for (let day = 0; day < 40; day += 1) {
      const n = 3 + Math.floor(rnd() * 5);
      const stops = Array.from({ length: n }, (_, i) => stop(`s${i}`, Math.floor(rnd() * 60), 8 + i, {
        lng: Math.floor(rnd() * 60), workMin: 20 + Math.floor(rnd() * 40), movable: rnd() > 0.3,
      }));
      const inp = input(stops);
      const r = planDay(inp);
      if (r.best) {
        expect(r.best.endMin).toBeLessThanOrEqual(r.current.endMin);
        replayAndCheck(inp, r);
      }
    }
  });
});

describe('multi-hour windows', () => {
  // A fixed 13:00-15:00 stop (it holds hours 13 and 14), a movable stop that may only go at 14:00, and a late
  // fixed stop that keeps the day open past 14:30.
  const wide = (fixedWidth) => input([
    stop('f', 10, 13, { movable: false, slotWidthMin: fixedWidth, workMin: 120 }),
    stop('m', 5, 9, { pref: { startMin: 14 * 60, endMin: 15 * 60 } }),
    stop('z', 0, 17, { movable: false }),
  ]);

  test('a fixed 2-hour window blocks a movable stop from its second hour', () => {
    const blocked = planDay(wide(120));
    expect(blocked.best).toBeNull();
    expect(blocked.reason).toBe('no_feasible_order');
  });

  test('the same day with a 1-hour fixed window lets the movable stop take 14:00', () => {
    const inp = wide(60);
    const r = planDay(inp);
    expect(r.best.slots.m).toBe(14 * 60);
    replayAndCheck(inp, r);
  });

  test('a movable 2-hour stop needs two free hours and holds both', () => {
    const blocked = input([
      stop('a', 10, 10, { movable: false }),
      stop('w', 5, 8, { slotWidthMin: 120, pref: { startMin: 9 * 60, endMin: 11 * 60 } }),
    ]);
    // Starting at 09:00 or 10:00 would overlap the fixed 10:00 stop.
    expect(planDay(blocked).reason).toBe('no_feasible_order');

    const open = input([
      stop('a', 10, 10, { movable: false }),
      stop('w', 5, 8, { slotWidthMin: 120 }),
      stop('b', 3, 12),
    ]);
    const r = planDay(open);
    expect(r.best).not.toBeNull();
    replayAndCheck(open, r);
    const wHour = r.best.slots.w / 60;
    // Its two hours are both free of the fixed stop's hour 10.
    expect([wHour, wHour + 1]).not.toContain(10);
  });

  test('a movable stop keeps its own width', () => {
    const inp = input([stop('w', 5, 8, { slotWidthMin: 120 }), stop('q', 4, 11)]);
    const r = planDay(inp);
    replayAndCheck(inp, r);
    expect(inp.stops[0].slotWidthMin).toBe(120);
  });
});

describe('the saving floor', () => {
  test('a saving below the floor is not accepted and lists no changes', () => {
    const r = planDay(input(zigzag(), { options: { minSavingMin: 71 } }));
    expect(r.savedMin).toBe(70);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('saving_below_floor');
    expect(r.changes).toEqual([]);
  });

  test('a saving exactly at the floor is accepted', () => {
    const r = planDay(input(zigzag(), { options: { minSavingMin: 70 } }));
    expect(r.accepted).toBe(true);
  });

  test('the default floor is 10 minutes', () => {
    // Re-ordering saves 8 minutes of driving here: under the floor.
    const stops = [stop('a', 10, 8), stop('b', 0, 9, { lat: 0, lng: 10 }), stop('c', 10, 10, { lat: 10, lng: 10 })];
    const r = planDay(input(stops));
    expect(r.current.driveMin).toBe(48);
    expect(r.savedMin).toBe(8);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('saving_below_floor');
  });
});

describe('many stops use local search', () => {
  function longDay() {
    const xs = [40, 5, 45, 10, 42, 8, 47, 12, 38, 3];
    return xs.map((x, i) => stop(`q${String(i).padStart(2, '0')}`, x, 8 + i, { workMin: 20 }));
  }

  test('ten stops stay feasible and do not get worse than today', () => {
    const inp = input(longDay());
    const r = planDay(inp);
    expect(r.best).not.toBeNull();
    replayAndCheck(inp, r);
    expect(r.best.driveMin).toBeLessThan(r.current.driveMin);
  });

  test('local search never beats the exhaustive search on the same day', () => {
    const stops = zigzag();
    const exact = planDay(input(stops));
    const local = planDay(input(stops, { options: { exactLimit: 2 } }));
    replayAndCheck(input(stops), local);
    expect(local.best.driveMin).toBeGreaterThanOrEqual(exact.best.driveMin);
  });
});

describe('determinism', () => {
  test('the same input gives the same answer', () => {
    const inp = input(zigzag());
    expect(planDay(inp)).toEqual(planDay(inp));
    const many = input(Array.from({ length: 11 }, (_, i) => stop(`r${i}`, (i * 37) % 53, 8 + (i % 10), { workMin: 15 })));
    expect(planDay(many)).toEqual(planDay(many));
  });

  test('ties break by id, not by the order the caller listed the stops', () => {
    // Two identical places: either order drives the same; the lower id goes first.
    const a = [stop('b', 10, 8), stop('a', 10, 9)];
    const r1 = planDay(input(a));
    const r2 = planDay(input([...a].reverse()));
    expect(r1.best.order).toEqual(r2.best.order);
  });
});

describe('edge cases', () => {
  test('an empty day plans nothing', () => {
    const r = planDay(input([]));
    expect(r.accepted).toBe(false);
    expect(r.current.driveMin).toBe(0);
  });
});

function mulberry(seed) {
  let a = seed;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
