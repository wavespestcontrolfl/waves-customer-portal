/**
 * buildBookingAvailability gap fan-out: find-time emits ONE
 * earliest-feasible-minute candidate per route gap, and the builder
 * previously offered only its hour-snap — when that single snapped start
 * landed in the lunch block or on an occupied hour, the gap's genuinely
 * free later hours were never generated and whole near-term days with real
 * capacity vanished from /book, the reschedule page, and /reservice
 * (2026-08-05 field report). The builder now fans out every grid-aligned
 * start up to the gap's latest_start_min bound (end still clears the drive
 * to the next stop), so the per-start rules reject starts, not days.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D = dayOffset(10);

const CONFIG = {
  advance_days_min: 1, advance_days_max: 14,
  slot_duration_minutes: 60,
  // 18:00 close since PR 2 (2026-09-23, scheduling/customer-windows.js
  // CUSTOMER_DAY_END_MINUTES) — a 17:00 start + the standard 60-minute
  // visit ends at 18:00.
  day_start: '08:00', day_end: '18:00',
  max_self_books_per_day: 3,
};

function gapSlot(startTime, extra = {}) {
  return {
    date: D,
    start_time: startTime,
    end_time: null,
    technician: { id: 'tech-1' },
    detour_minutes: 3,
    stops_that_day: 2,
    rank: 1,
    score: 10,
    insertion: { after_stop_id: 'stop-1' },
    ...extra,
  };
}

// db('self_booked_appointments') day-cap count query — thenable, no full days.
function wireDayCapCounts(rows = []) {
  const builder = {
    whereNot: jest.fn().mockReturnThis(),
    // The day cap also counts VOICE bookings off scheduled_services (they
    // write no self_booked_appointments row) — same thenable, no rows here.
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    // Effective-date count (SELF_BOOKING_EFFECTIVE_DATE_SQL) rides in via
    // whereRaw / db.raw select / groupByRaw — passthroughs; no linked live
    // rows here, so the copy dates stand.
    whereRaw: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
  return builder;
}

async function build(serviceKey = '', extra = {}) {
  return buildBookingAvailability({
    lat: 27.4, lng: -82.4, duration: 60,
    rangeFrom: D, rangeTo: D,
    config: CONFIG, today: new Date(), serviceKey, ...extra,
  });
}

const startTimes = (availability) => (availability.days[0]?.slots || []).map((s) => s.start_time);

describe('buildBookingAvailability — gap fan-out', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
  });

  test('capacity keeps only evaluated morning starts on an empty route with afternoon blocks', async () => {
    const gate = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      // Finder rejected 13:00–18:00 due to a technician block, which the
      // appointment-only occupancy reader does not expose to this builder.
      findAvailableSlots.mockResolvedValue({ slots: [gapSlot('09:00', {
        stops_that_day: 0, latest_start_min: 540,
      })], total_feasible: 1 });
      expect(startTimes(await build('', { expandOpenDays: true }))).toEqual(['09:00']);
    } finally {
      if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = gate;
    }
  });

  test('capacity public slots ignore another technician while retaining own and unassigned blockers', async () => {
    const gate = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    findAvailableSlots.mockResolvedValue({ slots: [gapSlot('10:00', { latest_start_min: 600 })], total_feasible: 1 });
    try {
      for (const technician_id of ['tech-2', 'tech-1', null]) {
        listOccupiedWindows.mockResolvedValue([{ date: D, startMin: 600, endMin: 660, technician_id }]);
        expect(startTimes(await build())).toEqual(technician_id === 'tech-2' ? ['10:00'] : []);
      }
    } finally {
      if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = gate;
    }
  });

  test('capacity offers and commit geometry retain a 16:00 ninety-minute service', async () => {
    const gate = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      findAvailableSlots.mockResolvedValue({ slots: [gapSlot('16:00', { latest_start_min: 960 })], total_feasible: 1 });
      expect(startTimes(await build('termite', { duration: 90 }))).toEqual(['16:00']);
      const { validateBookingSlotGeometry } = require('../routes/booking')._internals;
      expect(validateBookingSlotGeometry({ startMin: 960, duration: 90, config: CONFIG })).toBeNull();
      // A 17:00 start ending at 17:30 is now valid too (Codex r1 P1 on
      // #4663 — placementFitsShift used to require 2 hours of headroom past
      // start regardless of the job's own end, rejecting 17:00 even though
      // it ends well before the 18:00 close); a duration that would run
      // past 18:00 is still rejected.
      expect(validateBookingSlotGeometry({ startMin: 1020, duration: 30, config: CONFIG })).toBeNull();
      expect(validateBookingSlotGeometry({ startMin: 1020, duration: 90, config: CONFIG })).not.toBeNull();
    } finally {
      if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = gate;
    }
  });

  test('passes every selected service category to the capacity finder', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
    await build('pest_control+tree_shrub');
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ serviceTypes: ['Pest Control', 'Tree & Shrub'] }));
    // The booking's own expected-minutes credit is threaded into the finder
    // (Codex r2 P2) — no catalog reachable here, so it is the window length.
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ expectedMinutes: expect.any(Number), packEnds: true }));
  });

  // MERGE NOTE (round 5, reconciling with #4663's GATE_BOOKING_LUNCH_BLOCK):
  // #4663 was built on the pre-packed-ends fan-out (every grid hour up to
  // latest_start_min), so its own version of this scenario expected a
  // fallback fan-out into the free afternoon hours when the packed position
  // collided with lunch. That is exactly the hole-making full fan-out the
  // packed-ends fix (this branch, owner bug report 2026-09-23) replaced —
  // reviving it here would silently reintroduce the bug that fix closed.
  // Packed-ends still offers ONLY its one earliest position for a trailing
  // gap; the lunch admission rule (GATE_BOOKING_LUNCH_BLOCK, unset by
  // default) now governs whether THAT ONE position is blocked, not whether
  // a fallback fan-out runs (there is none — see the "no fallback fan-out"
  // comment on the fan-out block in booking.js).
  test('packed-ends: a trailing gap\'s one packed position collides with lunch — offers nothing (GATE_BOOKING_LUNCH_BLOCK=true)', async () => {
    // Gap opens 11:10 (snaps to 12:00 = lunch) and runs long enough to hold
    // starts through 15:30 — but this is a TRAILING gap (insertion.after_stop_id
    // set, no before_stop_id from the default gapSlot helper), so packing
    // restricts the fan-out to its one earliest position. That position
    // lands in lunch AND the gate is on, so the gap offers nothing — no
    // fallback fan-out.
    const previous = process.env.GATE_BOOKING_LUNCH_BLOCK;
    process.env.GATE_BOOKING_LUNCH_BLOCK = 'true';
    try {
      findAvailableSlots.mockResolvedValue({
        slots: [gapSlot('11:10', { latest_start_min: 15 * 60 + 30 })],
        total_feasible: 1,
      });
      const availability = await build();
      expect(availability.days).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GATE_BOOKING_LUNCH_BLOCK;
      else process.env.GATE_BOOKING_LUNCH_BLOCK = previous;
    }
  });

  test('packed-ends: the same trailing gap\'s one packed position (noon) IS offered once GATE_BOOKING_LUNCH_BLOCK is unset (default) — still only that one position, never the afternoon fan-out', async () => {
    const previous = process.env.GATE_BOOKING_LUNCH_BLOCK;
    delete process.env.GATE_BOOKING_LUNCH_BLOCK;
    try {
      findAvailableSlots.mockResolvedValue({
        slots: [gapSlot('11:10', { latest_start_min: 15 * 60 + 30 })],
        total_feasible: 1,
      });
      const availability = await build();
      expect(startTimes(availability)).toEqual(['12:00']);
    } finally {
      if (previous === undefined) delete process.env.GATE_BOOKING_LUNCH_BLOCK;
      else process.env.GATE_BOOKING_LUNCH_BLOCK = previous;
    }
  });

  test('packed-ends: a trailing gap offers its one earliest packed start; an occupied hour elsewhere in the gap is never even attempted', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('13:00', { latest_start_min: 15 * 60 })],
      total_feasible: 1,
    });
    listOccupiedWindows.mockResolvedValue([{ date: D, startMin: 14 * 60, endMin: 15 * 60 }]);
    const availability = await build();
    expect(startTimes(availability)).toEqual(['13:00']);
  });

  test('packed-ends: a middle gap (real stop on both sides) offers both the earliest-after and latest-before positions', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('11:10', {
        latest_start_min: 15 * 60 + 30,
        insertion: { after_stop_id: 'stop-1', before_stop_id: 'stop-2' },
      })],
      total_feasible: 1,
    });
    const availability = await build();
    // Earliest packed (ceil 11:10 -> 12:00) and latest packed (floor 15:30
    // -> 15:00) both survive — a middle gap tries both ends independently,
    // unlike the single-end trailing/leading case. Noon is no longer
    // dropped by default now that GATE_BOOKING_LUNCH_BLOCK is unset
    // (owner ruling 2026-09-23, #4663) — see the next test for the gate-on
    // case, where the earliest position still collides with lunch.
    expect(startTimes(availability)).toEqual(['12:00', '15:00']);
  });

  test('packed-ends: the same middle gap\'s earliest position collides with lunch and is dropped once GATE_BOOKING_LUNCH_BLOCK is on, but the latest position is unaffected', async () => {
    const previous = process.env.GATE_BOOKING_LUNCH_BLOCK;
    process.env.GATE_BOOKING_LUNCH_BLOCK = 'true';
    try {
      findAvailableSlots.mockResolvedValue({
        slots: [gapSlot('11:10', {
          latest_start_min: 15 * 60 + 30,
          insertion: { after_stop_id: 'stop-1', before_stop_id: 'stop-2' },
        })],
        total_feasible: 1,
      });
      const availability = await build();
      expect(startTimes(availability)).toEqual(['15:00']);
    } finally {
      if (previous === undefined) delete process.env.GATE_BOOKING_LUNCH_BLOCK;
      else process.env.GATE_BOOKING_LUNCH_BLOCK = previous;
    }
  });

  test('packed-ends: a leading gap (day-open before, real stop after) offers ONLY its latest packed start', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('08:05', {
        latest_start_min: 11 * 60,
        insertion: { after_stop_id: null, before_stop_id: 'stop-1' },
      })],
      total_feasible: 1,
    });
    const availability = await build();
    expect(startTimes(availability)).toEqual(['11:00']);
  });

  test('the fan-out never passes latest_start_min — a snap past the bound offers nothing', async () => {
    // Gap 14:10–15:10: the hour-snap (15:00 + 60 min) would end past what the
    // route can reach; the old single-candidate path offered it anyway.
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('14:10', { latest_start_min: 14 * 60 + 10 })],
      total_feasible: 1,
    });
    const availability = await build();
    expect(availability.days).toEqual([]);
  });

  test('a slot without latest_start_min falls back to the single snapped start (legacy shape)', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('09:10')],
      total_feasible: 1,
    });
    const availability = await build();
    expect(startTimes(availability)).toEqual(['10:00']);
  });

  test('nearby is stamped per slot (the picker labels each time from its own flag), the day rolls it up', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('09:00', { detour_minutes: 3, latest_start_min: null }), gapSlot('13:00', { detour_minutes: 25, latest_start_min: null })],
      total_feasible: 2,
    });
    const availability = await build();
    expect(availability.days[0].slots.map((s) => [s.start_time, s.nearby])).toEqual([['09:00', true], ['13:00', false]]);
    expect(availability.days[0].nearby).toBe(true);
  });

  test('empty-day 08:00 snap-down is preserved and the day fans out past it', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('08:05', {
        stops_that_day: 0,
        insertion: { after_stop_id: null },
        latest_start_min: 15 * 60 + 59,
      })],
      total_feasible: 1,
    });
    const availability = await build();
    // Keep the full day so a search result is also valid at confirmation.
    // Includes 12:00: GATE_BOOKING_LUNCH_BLOCK is unset (default) in this
    // suite, so noon is a normal offerable hour (owner ruling 2026-09-23).
    expect(startTimes(availability)).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00']);
  });

  test('an open day (expandOpenDays, no existing stops) fans out the full OPEN_DAY_WINDOWS grid, 09:00 through 17:00', async () => {
    // Non-capacity path, a day with zero stops so far: this is the ONLY
    // branch that reads OPEN_DAY_WINDOWS directly (scheduling/customer-windows.js
    // CUSTOMER_HOUR_GRID) rather than fanning out a route gap.
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('09:00', { stops_that_day: 0 })],
      total_feasible: 1,
    });
    const availability = await build('', { expandOpenDays: true });
    expect(startTimes(availability)).toEqual([
      '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
    ]);
  });

  test('the same open day drops noon when GATE_BOOKING_LUNCH_BLOCK is true', async () => {
    const previous = process.env.GATE_BOOKING_LUNCH_BLOCK;
    process.env.GATE_BOOKING_LUNCH_BLOCK = 'true';
    try {
      findAvailableSlots.mockResolvedValue({
        slots: [gapSlot('09:00', { stops_that_day: 0 })],
        total_feasible: 1,
      });
      const availability = await build('', { expandOpenDays: true });
      expect(startTimes(availability)).toEqual([
        '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00',
      ]);
    } finally {
      if (previous === undefined) delete process.env.GATE_BOOKING_LUNCH_BLOCK;
      else process.env.GATE_BOOKING_LUNCH_BLOCK = previous;
    }
  });
});

test('an afternoon search result remains in the unfiltered confirmation-day list', async () => {
  wireDayCapCounts([]);
  listOccupiedWindows.mockResolvedValue([]);
  // stops_that_day: 0 — an empty-route gap keeps the full-fan-out path
  // (packed-ends restriction only applies once a real stop borders the
  // gap), which is what this test's full-day fan-out invariant exercises.
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot('08:00', { latest_start_min: 16 * 60, stops_that_day: 0 })] });
  const opts = { lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date() };
  const searched = await buildBookingAvailability({ ...opts, timeOfDay: 'afternoon' });
  const confirmation = await buildBookingAvailability(opts);
  expect(startTimes(searched)).toContain('13:00');
  for (const time of startTimes(searched)) expect(startTimes(confirmation)).toContain(time);
});

test.each(['self-booking', 'voice'])('a same-day %s move excludes itself from the day cap', async origin => {
  // GATE_SELF_BOOK_DAY_CAP (owner ruling 2026-09-23): dark by default —
  // this test is about the cap itself, so force it on.
  process.env.GATE_SELF_BOOK_DAY_CAP = 'true';
  listOccupiedWindows.mockResolvedValue([]);
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot('13:00', { latest_start_min: 16 * 60 })] });
  const subquery = { select() { return this; }, from() { return this; }, as() { return this; }, whereNot: jest.fn().mockReturnThis() };
  const voiceQuery = { where: () => voiceQuery, whereNotIn: jest.fn().mockReturnThis(), whereBetween: () => voiceQuery,
    select: () => voiceQuery, count: () => voiceQuery, groupBy: () => voiceQuery,
    then: resolve => resolve(origin === 'voice' ? [{ scheduled_date: D, count: voiceQuery.whereNotIn.mock.calls.some(([key]) => key === 'id') ? 2 : 3 }] : []),
  };
  db.raw = sql => sql;
  db.mockImplementation(table => {
    if (table === 'scheduled_services') return voiceQuery;
    table.call(subquery);
    const q = { whereBetween: () => q, select: () => q, count: () => q, groupBy: () => q,
      then: resolve => resolve(origin === 'self-booking' ? [{ date: D, count: subquery.whereNot.mock.calls.some(([key]) => key === 'id') ? 2 : 3 }] : []),
    };
    return q;
  });
  const opts = { lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date() };
  try {
    expect((await buildBookingAvailability(opts)).days).toHaveLength(0);
    const moved = await buildBookingAvailability({ ...opts, excludeServiceIds: ['moving-visit'], excludeSelfBookingId: origin === 'self-booking' ? 'moving-booking' : null });
    expect(startTimes(moved)).toContain('13:00');
  } finally {
    delete process.env.GATE_SELF_BOOK_DAY_CAP;
  }
});

// Codex r3 P0 on #4663: capacity mode's shared find-time shift starts at
// 08:00 for every caller, but the documented public/token offer grid is
// 09:00-17:00. buildBookingAvailability's self-serve callers (this file's
// /availability, /find-slots, capture-intent revalidation; reschedule-public.js;
// reservice-public.js) must mark themselves customerFacing so capacity mode
// never hands them an 08:00 candidate; the voice-agent callers (relay-tools.js,
// relay-booking.js), which never set selfServeNotice, must not be narrowed.
describe('buildBookingAvailability — customerFacing propagation to find-time', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [] });
  });

  test('a self-serve caller (selfServeNotice: true) marks the find-time call customerFacing', async () => {
    await buildBookingAvailability({
      lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D,
      config: CONFIG, today: new Date(), selfServeNotice: true,
    });
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ customerFacing: true }));
  });

  test('a voice-agent caller (no selfServeNotice) does not mark the find-time call customerFacing', async () => {
    await buildBookingAvailability({
      lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D,
      config: CONFIG, today: new Date(),
    });
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ customerFacing: false }));
  });

  // Codex r4 P0 on #4663: GATE_SCHEDULING_CAPACITY unset never reaches
  // find-time's own customerFacing filter (findCapacitySlots), so an idle
  // route's exact 08:00 route-derived candidate (zero modeled drive from
  // the HQ opening anchor) survived addCandidate's dayStartMin(08:00) check
  // and reached self-serve offer/commit surfaces. addCandidate now also
  // runs customerWindowAdmits (the documented 09:00-17:00 grid) for
  // self-serve callers, in BOTH capacity modes.
  //
  // MERGE NOTE (round 5): #4663's own version of this test expected the
  // self-serve caller to fall back to 09:00 — the pre-packed-ends fan-out
  // walked every 15-minute grid point in the gap, so rejecting 08:00 still
  // left 08:15, 08:30, ... 09:00 to try. This fixture's gapSlot carries
  // insertion.after_stop_id (a trailing gap), so packed-ends tries ONLY
  // that one packed position (08:00) — consistent with every other packed-
  // ends test in this file, a caller the packed position is inadmissible
  // for gets nothing from that gap, not a fallback to the next open hour.
  // The intent #4663 was protecting (self-serve never sees 08:00; voice
  // still can) is unchanged and still asserted below.
  test('gate-off self-serve caller never offers the exact 08:00 route-derived candidate (packed-ends: nothing, not a 09:00 fallback); a voice-style caller still can', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [gapSlot('08:00', { latest_start_min: 16 * 60 })] });
    const base = { lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date() };
    const selfServe = await buildBookingAvailability({ ...base, selfServeNotice: true });
    const voice = await buildBookingAvailability(base);
    expect(startTimes(selfServe)).not.toContain('08:00');
    expect(startTimes(selfServe)).toEqual([]);
    expect(startTimes(voice)).toContain('08:00');
  });

  // The same grid rule DOES surface a fallback when the packed-ends caller
  // has a real neighbour on the other side too (a middle gap tries both
  // ends independently — see the packed-ends describe block above): only
  // the after-stop-1 side's 08:00 position is grid-inadmissible; the
  // before-stop-2 side's own packed position is unaffected.
  test('a middle gap\'s grid-inadmissible earliest side still lets its own latest side through for a self-serve caller', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('08:00', {
        latest_start_min: 15 * 60,
        insertion: { after_stop_id: 'stop-1', before_stop_id: 'stop-2' },
      })],
    });
    const selfServe = await buildBookingAvailability({
      lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D,
      config: CONFIG, today: new Date(), selfServeNotice: true,
    });
    expect(startTimes(selfServe)).not.toContain('08:00');
    expect(startTimes(selfServe)).toEqual(['15:00']);
  });

  // Push-audit P1 on #4663: addCandidate's customerWindowAdmits() call
  // defaults dayEndMinutes to currentDayEndMinutes() — scheduling/
  // customer-windows.js's shared, 60s-TTL cache — which this file never
  // had to warm before customerWindowAdmits existed (its own bounds always
  // came straight from the freshly-loaded `config`). Prove
  // buildBookingAvailability warms that cache itself, so a reconfigured
  // booking_config.day_end narrower than the passed-in `config` still
  // narrows the offer the moment this request reads it, not up to 60s
  // later.
  test('buildBookingAvailability warms the customer-windows cache with the LIVE booking_config row before generating candidates', async () => {
    // CONFIG (passed in, used for addCandidate's OWN dayStartMin/dayEndMin
    // check) keeps its normal 18:00 day_end — 17:00+60=18:00 fits it fine.
    // The mocked booking_config ROW (what a fresh read would return) is a
    // tighter 16:00 — only customerWindowAdmits()'s live-cache default
    // reads that value. Without the refresh this test guards, the cache
    // would never see the tighter row and currentDayEndMinutes() would
    // fall back to the fixed 18:00 constant, wrongly admitting 17:00.
    findAvailableSlots.mockResolvedValue({ slots: [gapSlot('17:00', { latest_start_min: 17 * 60 })] });
    const bookingConfigBuilder = { first: jest.fn().mockResolvedValue({ day_end: '16:00:00', lunch_start: null, lunch_end: null }) };
    db.mockImplementation((table) => {
      if (table === 'booking_config') return bookingConfigBuilder;
      throw new Error(`unexpected table ${table}`);
    });
    const result = await buildBookingAvailability({
      lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date(), selfServeNotice: true,
    });
    expect(bookingConfigBuilder.first).toHaveBeenCalled();
    expect(startTimes(result)).not.toContain('17:00');
  });
});
