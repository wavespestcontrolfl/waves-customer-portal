/**
 * GATE_RESERVICE_RANK_AFTER_NEW — re-service slots rank after new customers
 * (owner ruling 2026-09-24: "prefer new customers over existing — new-
 * customer bookings get first pick of open time; re-service/callback
 * pickers rank after"). Covers the pure penalty/horizon primitives and
 * buildBookingAvailability's rankProfile:'reservice' opt-in end to end:
 * gate off (or no profile) is byte-identical to today; gate on demotes
 * empty-day slots and promotes tightly packed ones; a within-5-business-day
 * slot is guaranteed a strip seat when one is feasible; the offered slot
 * SET (days[].slots) is never filtered.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/packing-geometry', () => ({ loadPackingAnchors: jest.fn() }));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadPackingAnchors } = require('../services/scheduling/packing-geometry');
const {
  buildBookingAvailability,
  curateSlots,
  reserviceAdjustedScore,
  reserviceStopsThatDay,
  promoteLatencyPickRank,
  isReserviceNearbySlot,
  reservicePickerStripOrder,
  businessDayHorizonEnd,
  RESERVICE_EMPTY_DAY_PENALTY_MINUTES,
  RESERVICE_IDLE_WEIGHT,
  RESERVICE_LATENCY_BUSINESS_DAYS,
  NEARBY_DETOUR_MINUTES,
} = require('../routes/booking')._internals;
const { etDateString, addETDays, addETBusinessDays, parseETDateTime } = require('../utils/datetime-et');

const NOW = parseETDateTime(`${etDateString()}T12:00`);
const dayOffset = (n) => etDateString(addETDays(NOW, n));

const CONFIG = {
  advance_days_min: 1, advance_days_max: 30,
  slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00',
  max_self_books_per_day: 3,
};

const GATE = 'GATE_RESERVICE_RANK_AFTER_NEW';

function withGate(value, fn) {
  const previous = process.env[GATE];
  if (value == null) delete process.env[GATE]; else process.env[GATE] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env[GATE]; else process.env[GATE] = previous;
  });
}

// One capacity-mode candidate per mocked slot (addCandidate takes the exact
// start_time — see buildBookingAvailability's capacityEnabled() branch), so
// each test controls score/stops_that_day/date directly without needing a
// real route gap to fan out. `rank` mirrors find-time's own contract (each
// slot's position in GLOBAL ascending-score order) — only load-bearing for
// the is_best_fit assertions below.
function capacitySlot(date, { score = 5, stopsThatDay = 0, startTime = '10:00', rank = 1, detourMinutes = 3, technicianId = 'tech-1' } = {}) {
  return {
    date, start_time: startTime, end_time: null,
    technician: { id: technicianId }, detour_minutes: detourMinutes,
    stops_that_day: stopsThatDay, rank, score, insertion: {},
  };
}

// slot_sig embeds a mint timestamp (utils/slot-offer-token.js) — real,
// deliberate non-determinism between two separate builds. Strip it before
// any structural equality check.
function stripSig(value) {
  return JSON.parse(JSON.stringify(value, (key, val) => (key === 'slot_sig' ? undefined : val)));
}

async function build(slots, extra = {}) {
  const gate = process.env.GATE_SCHEDULING_CAPACITY;
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  findAvailableSlots.mockResolvedValue({ slots, total_feasible: slots.length });
  try {
    return await buildBookingAvailability({
      lat: 27.4, lng: -82.4, duration: 60,
      rangeFrom: dayOffset(1), rangeTo: dayOffset(60),
      config: CONFIG, today: NOW, ...extra,
    });
  } finally {
    if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = gate;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  loadPackingAnchors.mockResolvedValue([]);
});

describe('reserviceAdjustedScore / businessDayHorizonEnd (pure)', () => {
  test('an empty day (stops_that_day 0) adds the full empty-day penalty', () => {
    expect(reserviceAdjustedScore({ score: 5, stops_that_day: 0, idle_minutes: 0 }))
      .toBe(5 + RESERVICE_EMPTY_DAY_PENALTY_MINUTES);
  });

  test('a day with existing stops adds no empty-day penalty', () => {
    expect(reserviceAdjustedScore({ score: 5, stops_that_day: 3, idle_minutes: 0 })).toBe(5);
  });

  test('idle_minutes is weighted below 1:1 against the base score', () => {
    expect(reserviceAdjustedScore({ score: 5, stops_that_day: 2, idle_minutes: 100 }))
      .toBe(5 + 100 * RESERVICE_IDLE_WEIGHT);
  });

  test('a missing stops_that_day (legacy/undefined) is treated as empty', () => {
    expect(reserviceAdjustedScore({ score: 5, idle_minutes: 0 })).toBe(5 + RESERVICE_EMPTY_DAY_PENALTY_MINUTES);
  });

  test('businessDayHorizonEnd skips Saturday and Sunday', () => {
    // A known Monday: 2026-09-28 is a Monday (2026-09-26 is a Saturday).
    const monday = parseETDateTime('2026-09-28T12:00');
    // 5 business days after a Monday: Tue,Wed,Thu,Fri,Mon(+1 week) = Oct 5.
    expect(businessDayHorizonEnd(monday, 5)).toBe('2026-10-05');
  });

  test('businessDayHorizonEnd counts from the NEXT calendar day, not today', () => {
    const monday = parseETDateTime('2026-09-28T12:00');
    expect(businessDayHorizonEnd(monday, 1)).toBe('2026-09-29'); // Tuesday
  });

  test('businessDayHorizonEnd delegates to the shared addETBusinessDays (server/utils/datetime-et.js), also used by routes/stripe-webhook.js', () => {
    const monday = parseETDateTime('2026-09-28T12:00');
    expect(businessDayHorizonEnd(monday, 5)).toBe(etDateString(addETBusinessDays(monday, 5)));
  });
});

describe('reserviceStopsThatDay (pure) — the unassigned-committed-visit fix (Codex r1 P1 on #4926)', () => {
  test('a positive raw count is returned as-is (occupancy is never consulted)', () => {
    expect(reserviceStopsThatDay(null, '2026-10-01', 3)).toBe(3);
    expect(reserviceStopsThatDay(new Map(), '2026-10-01', 2)).toBe(2);
  });

  test('raw 0 with no occupancy data at all (map missing the date, or unavailable): stays empty', () => {
    expect(reserviceStopsThatDay(null, '2026-10-01', 0)).toBe(0);
    expect(reserviceStopsThatDay(new Map(), '2026-10-01', 0)).toBe(0);
  });

  test('raw 0 (capacity mode: the selected technician has no stops) but a GLOBAL committed visit exists that date (e.g. unassigned) — NOT empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: null, hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0)).toBe(1);
  });

  test('raw 0 with only a reservation HOLD that date (no customer yet) — still counts as empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: null, hold: true }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0)).toBe(0);
  });

  test('raw 0 with a mix of a hold and a real committed row — the real row makes it not-empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ hold: true }, { hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0)).toBe(1);
  });

  // Pre-push audit P1 on #4926: the fallback used to count ANY committed
  // stop on the date regardless of technician, so a busy tech-A made an
  // actually-empty tech-B look occupied and let B dodge the penalty (and
  // potentially win the per-start dedupe over a genuinely packed A).
  test('raw 0 with a real committed row belonging to a DIFFERENT technician — still empty for THIS technician', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: 'tech-A', hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-B')).toBe(0);
  });

  test('raw 0 with a real committed row belonging to THIS SAME technician — not empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: 'tech-A', hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-A')).toBe(1);
  });

  test('raw 0 with an unassigned (technician_id: null) row — not empty for ANY technician', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: null, hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-A')).toBe(1);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-B')).toBe(1);
  });

  test('a mix of another technician\'s row and this technician\'s own row — this technician\'s own row makes it not-empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [
      { technician_id: 'tech-other', hold: false },
      { technician_id: 'tech-A', hold: false },
    ]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-A')).toBe(1);
  });
});

describe('promoteLatencyPickRank (pure) — client-visibility fix (Codex r1 P1 on #4926)', () => {
  // client/src/components/booking/SchedulePicker.jsx's PickerBestTimes
  // re-sorts the curated 4 by `rank` ascending and shows only the best 3.
  // These fixtures carry no `detour_minutes`, so isReserviceNearbySlot
  // reads every pick as equally "not nearby" — the nearby key is a no-op
  // tie and pure rank order decides, exactly like PickerBestTimes' own
  // fallback. The dedicated "nearby-aware" describe block below exercises
  // the nearby key itself.
  const top3ByRank = (picks) => [...picks].sort((a, b) => a.rank - b.rank).slice(0, 3);

  test('a no-op when there are fewer than 4 picks (nothing is ever hidden)', () => {
    const picks = [{ date: '2026-10-01', rank: 3 }, { date: '2026-10-02', rank: 1 }, { date: '2026-10-03', rank: 2 }];
    const before = picks.map((p) => ({ ...p }));
    promoteLatencyPickRank(picks, '2026-10-01');
    expect(picks).toEqual(before);
  });

  test('a no-op when no pick falls within the horizon', () => {
    const picks = [
      { date: '2026-10-10', rank: 4 }, { date: '2026-10-11', rank: 1 },
      { date: '2026-10-12', rank: 2 }, { date: '2026-10-13', rank: 3 },
    ];
    const before = picks.map((p) => ({ ...p }));
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toEqual(before);
  });

  test('a no-op when the within-horizon pick is already in the top 3 by rank', () => {
    const picks = [
      { date: '2026-10-02', rank: 1 }, { date: '2026-10-11', rank: 2 },
      { date: '2026-10-12', rank: 3 }, { date: '2026-10-13', rank: 4 },
    ];
    const before = picks.map((p) => ({ ...p }));
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toEqual(before);
  });

  test('a within-horizon pick ranked worst (4th) is swapped into the 3rd-best rank — it now survives the client\'s top-3 slice', () => {
    const nearPick = { date: '2026-10-02', rank: 4 };
    const picks = [
      { date: '2026-10-11', rank: 1 }, { date: '2026-10-12', rank: 2 },
      { date: '2026-10-13', rank: 3 }, nearPick,
    ];
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(top3ByRank(picks).map((p) => p.date)).toContain('2026-10-02');
    // The pick that HELD the 3rd-best rank is the one bumped to worst — no
    // rank is duplicated or lost.
    expect(picks.map((p) => p.rank).sort()).toEqual([1, 2, 3, 4]);
    expect(nearPick.rank).toBe(3);
  });

  test('with two within-horizon picks, only the rank-4 one is worse than top-3 and gets promoted — the already-qualifying one is untouched', () => {
    // Both 2026-10-02 (rank 4) and 2026-10-03 (rank 3) are within horizon;
    // the BEST of the two (rank 3) already clears the top-3 cut, so
    // reduce()'s protectedPick selection (lowest rank among in-horizon
    // picks) correctly finds nothing to promote.
    const picks = [
      { date: '2026-10-11', rank: 1 }, { date: '2026-10-12', rank: 2 },
      { date: '2026-10-02', rank: 4 }, { date: '2026-10-03', rank: 3 },
    ];
    const before = picks.map((p) => ({ ...p }));
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toEqual(before);
  });
});

describe('isReserviceNearbySlot / reservicePickerStripOrder (pure) — mirrors PickerBestTimes\' exact comparator', () => {
  test('isReserviceNearbySlot: at or under the threshold is nearby, over it is not, null/undefined detour is not', () => {
    expect(isReserviceNearbySlot({ detour_minutes: NEARBY_DETOUR_MINUTES })).toBe(true);
    expect(isReserviceNearbySlot({ detour_minutes: NEARBY_DETOUR_MINUTES - 1 })).toBe(true);
    expect(isReserviceNearbySlot({ detour_minutes: NEARBY_DETOUR_MINUTES + 1 })).toBe(false);
    expect(isReserviceNearbySlot({ detour_minutes: null })).toBe(false);
    expect(isReserviceNearbySlot({})).toBe(false);
  });

  test('reservicePickerStripOrder: nearby beats a better rank — the exact PickerBestTimes tie-break order', () => {
    const nearbyWorseRank = { date: 'a', rank: 4, detour_minutes: 3 };
    const farBetterRank = { date: 'b', rank: 1, detour_minutes: 30 };
    const ordered = reservicePickerStripOrder([farBetterRank, nearbyWorseRank]);
    expect(ordered).toEqual([nearbyWorseRank, farBetterRank]);
  });

  test('reservicePickerStripOrder: within the same nearby bucket, rank decides', () => {
    const worse = { date: 'a', rank: 2, detour_minutes: 3 };
    const better = { date: 'b', rank: 1, detour_minutes: 5 };
    expect(reservicePickerStripOrder([worse, better])).toEqual([better, worse]);
  });

  test('reservicePickerStripOrder: original array position breaks a tie when neither side has a usable rank', () => {
    const first = { date: 'a', detour_minutes: 3 };
    const second = { date: 'b', detour_minutes: 3 };
    expect(reservicePickerStripOrder([first, second])).toEqual([first, second]);
    expect(reservicePickerStripOrder([second, first])).toEqual([second, first]);
  });
});

describe('promoteLatencyPickRank — nearby-aware branches (pre-push audit P1 on #4926)', () => {
  const NEAR = NEARBY_DETOUR_MINUTES - 5; // comfortably nearby
  const FAR = NEARBY_DETOUR_MINUTES + 20; // comfortably not nearby

  test('protected pick and the boundary pick share a nearby bucket (both far): a rank swap is enough', () => {
    const protectedPick = { date: '2026-10-02', rank: 4, detour_minutes: FAR };
    const picks = [
      { date: '2026-10-11', rank: 1, detour_minutes: FAR },
      { date: '2026-10-12', rank: 2, detour_minutes: FAR },
      { date: '2026-10-13', rank: 3, detour_minutes: FAR },
      protectedPick,
    ];
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toHaveLength(4);
    expect(protectedPick.rank).toBe(3);
    expect(reservicePickerStripOrder(picks).slice(0, 3)).toContain(protectedPick);
  });

  test('protected pick and the boundary pick share a nearby bucket (both nearby): a rank swap is enough', () => {
    const protectedPick = { date: '2026-10-02', rank: 4, detour_minutes: NEAR };
    const picks = [
      { date: '2026-10-11', rank: 1, detour_minutes: NEAR },
      { date: '2026-10-12', rank: 2, detour_minutes: NEAR },
      { date: '2026-10-13', rank: 3, detour_minutes: NEAR },
      protectedPick,
    ];
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toHaveLength(4);
    expect(protectedPick.rank).toBe(3);
    expect(reservicePickerStripOrder(picks).slice(0, 3)).toContain(protectedPick);
  });

  test('protected pick is NOT nearby but 3 peers ARE — no rank swap can rescue it (nearby beats rank in the client\'s own sort), so the boundary pick is dropped instead, leaving exactly 3', () => {
    const protectedPick = { date: '2026-10-02', rank: 4, detour_minutes: FAR };
    const nearbyPeer1 = { date: '2026-10-11', rank: 1, detour_minutes: NEAR };
    const nearbyPeer2 = { date: '2026-10-12', rank: 2, detour_minutes: NEAR };
    const nearbyPeer3 = { date: '2026-10-13', rank: 3, detour_minutes: NEAR };
    const picks = [nearbyPeer1, nearbyPeer2, nearbyPeer3, protectedPick];
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toHaveLength(3);
    expect(picks).toContain(protectedPick);
    // The boundary pick (stripOrder[2] before the drop) is the one removed —
    // here that is the WORST-ranked of the three nearby peers.
    expect(picks).not.toContain(nearbyPeer3);
    expect(picks).toContain(nearbyPeer1);
    expect(picks).toContain(nearbyPeer2);
    // The client's own comparator now shows protectedPick among the visible
    // (at most 3) results, unconditionally.
    expect(reservicePickerStripOrder(picks).slice(0, 3)).toContain(protectedPick);
  });

  test('protected pick IS nearby but 3 OTHER nearby peers outrank it — same bucket, so a rank swap (not a drop) fixes it', () => {
    const protectedPick = { date: '2026-10-02', rank: 4, detour_minutes: NEAR };
    const picks = [
      { date: '2026-10-11', rank: 1, detour_minutes: NEAR },
      { date: '2026-10-12', rank: 2, detour_minutes: NEAR },
      { date: '2026-10-13', rank: 3, detour_minutes: NEAR },
      protectedPick,
    ];
    promoteLatencyPickRank(picks, '2026-10-05');
    expect(picks).toHaveLength(4); // no drop — a swap sufficed
    expect(reservicePickerStripOrder(picks).slice(0, 3)).toContain(protectedPick);
  });
});

describe('curateSlots latencyCutoffDate option', () => {
  const today = NOW;
  function slot(date, score, startTime = '10:00') {
    return { date, start_time: startTime, score, rank: 1, idle_minutes: 0 };
  }

  test('omitted opts: byte-identical to the original calendar 3-day swap (no behavior change for other callers)', () => {
    const candidates = [slot(dayOffset(10), 1), slot(dayOffset(11), 2), slot(dayOffset(12), 3), slot(dayOffset(13), 4), slot(dayOffset(1), 20)];
    const withNoOpts = curateSlots(candidates, today);
    const withEmptyOpts = curateSlots(candidates, today, {});
    expect(withNoOpts).toEqual(withEmptyOpts);
  });

  test('a within-horizon candidate not already picked replaces the worst pick', () => {
    const cutoff = dayOffset(5);
    const candidates = [
      slot(dayOffset(20), 1), slot(dayOffset(21), 2), slot(dayOffset(22), 3), slot(dayOffset(23), 4),
      slot(dayOffset(3), 50), // within horizon, but scores worse than all 4 above
    ];
    const picks = curateSlots(candidates, today, { latencyCutoffDate: cutoff });
    expect(picks.map((s) => s.date)).toContain(dayOffset(3));
    expect(picks.map((s) => s.date)).not.toContain(dayOffset(23)); // the worst-scored pick was swapped out
    expect(picks).toHaveLength(4);
  });

  test('a pick already inside the horizon: no swap needed', () => {
    const cutoff = dayOffset(5);
    const candidates = [slot(dayOffset(2), 1), slot(dayOffset(10), 2), slot(dayOffset(11), 3), slot(dayOffset(12), 4)];
    const picks = curateSlots(candidates, today, { latencyCutoffDate: cutoff });
    expect(picks.map((s) => s.date)).toEqual([dayOffset(2), dayOffset(10), dayOffset(11), dayOffset(12)]);
  });
});

describe('buildBookingAvailability — rankProfile: reservice (end to end)', () => {
  test('gate off + rankProfile "reservice": byte-identical to no profile at all', async () => {
    const slots = [
      capacitySlot(dayOffset(10), { score: 1, stopsThatDay: 0 }), // best raw score, empty day
      capacitySlot(dayOffset(11), { score: 2, stopsThatDay: 2 }),
      capacitySlot(dayOffset(12), { score: 3, stopsThatDay: 2 }),
      capacitySlot(dayOffset(13), { score: 4, stopsThatDay: 2 }),
      capacitySlot(dayOffset(14), { score: 6, stopsThatDay: 2 }),
    ];
    await withGate(null, async () => {
      const withProfile = await build(slots, { rankProfile: 'reservice' });
      const withoutProfile = await build(slots, {});
      expect(stripSig(withProfile.slots)).toEqual(stripSig(withoutProfile.slots));
      expect(stripSig(withProfile.days)).toEqual(stripSig(withoutProfile.days));
      // Byte-for-byte proof: the raw-best-score empty day (dayOffset(10))
      // is still in the curated strip when the gate is off.
      expect(withProfile.slots.map((s) => s.date)).toContain(dayOffset(10));
    });
  });

  test('gate on, but NO rankProfile (the /book path): unaffected', async () => {
    const slots = [
      capacitySlot(dayOffset(10), { score: 1, stopsThatDay: 0 }),
      capacitySlot(dayOffset(11), { score: 2, stopsThatDay: 2 }),
      capacitySlot(dayOffset(12), { score: 3, stopsThatDay: 2 }),
      capacitySlot(dayOffset(13), { score: 4, stopsThatDay: 2 }),
      capacitySlot(dayOffset(14), { score: 6, stopsThatDay: 2 }),
    ];
    await withGate('true', async () => {
      const withGateOn = await build(slots, {});
      const gateUnset = await withGate(null, () => build(slots, {}));
      expect(stripSig(withGateOn.slots)).toEqual(stripSig(gateUnset.slots));
      expect(withGateOn.slots.map((s) => s.date)).toContain(dayOffset(10));
    });
  });

  test('gate on + rankProfile "reservice": an empty day with the best raw score is demoted out of the curated strip in favor of a worse-raw-scored packed day', async () => {
    const emptyDate = dayOffset(10);
    const packedDates = [dayOffset(11), dayOffset(12), dayOffset(13), dayOffset(14)];
    const slots = [
      capacitySlot(emptyDate, { score: 1, stopsThatDay: 0 }), // best raw score, but empty
      capacitySlot(packedDates[0], { score: 2, stopsThatDay: 2 }),
      capacitySlot(packedDates[1], { score: 3, stopsThatDay: 2 }),
      capacitySlot(packedDates[2], { score: 4, stopsThatDay: 2 }),
      capacitySlot(packedDates[3], { score: 6, stopsThatDay: 2 }), // worst raw score, but packed
    ];
    await withGate('true', async () => {
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      expect(curatedDates).not.toContain(emptyDate);
      // All 4 packed days now make the cut, including the worst-raw-scored one.
      expect(curatedDates.sort()).toEqual([...packedDates].sort());
      // The full per-day grid still lists the empty day — nothing is
      // filtered, only the suggested strip's membership changed.
      expect(result.days.map((d) => d.date)).toContain(emptyDate);
      const emptyDay = result.days.find((d) => d.date === emptyDate);
      expect(emptyDay.slots).toHaveLength(1);
    });
  });

  test('gate on + rankProfile "reservice": a slot packed against existing stops (low idle) outranks a same-day slot with a better raw score but a bigger hole', async () => {
    const date = dayOffset(10);
    // One committed stop 09:00-10:00 (540-600) that day.
    loadPackingAnchors.mockResolvedValue([{
      technician_id: 'tech-1', customer_id: 'cust-x', date,
      rawStartMin: 540, rawEndMin: 600, expectedEndMin: 600,
      lat: 27.4, lng: -82.4, hold: false,
    }]);
    const slots = [
      // Far from the anchor (16:00) — best RAW score, but leaves a big hole.
      capacitySlot(date, { score: 5, stopsThatDay: 2, startTime: '16:00', rank: 1 }),
      // Right after the anchor (10:00) — worse raw score, packed tight.
      capacitySlot(date, { score: 8, stopsThatDay: 2, startTime: '10:00', rank: 2 }),
    ];
    const withoutGate = await build(slots, { rankProfile: 'reservice' });
    const day0 = withoutGate.days.find((d) => d.date === date);
    // Plain ranking (gate off): lower raw score (5, the 16:00 hole-maker) wins.
    expect(day0.slots.find((s) => s.is_best_fit).start_time).toBe('16:00');

    const withGateOn = await withGate('true', () => build(slots, { rankProfile: 'reservice' }));
    const day1 = withGateOn.days.find((d) => d.date === date);
    // Adjusted ranking (gate on): the packed 10:00 slot's much lower idle
    // time outweighs its slightly worse raw score.
    expect(day1.slots.find((s) => s.is_best_fit).start_time).toBe('10:00');
  });

  test('latency guard: a within-5-business-day slot is guaranteed a strip seat even when it is empty-day-penalized against far-out packed days', async () => {
    await withGate('true', async () => {
      const cutoff = businessDayHorizonEnd(NOW, RESERVICE_LATENCY_BUSINESS_DAYS);
      const nearDate = cutoff; // on the horizon boundary — still "within"
      const farDates = [dayOffset(20), dayOffset(21), dayOffset(22), dayOffset(23)];
      const slots = [
        capacitySlot(nearDate, { score: 5, stopsThatDay: 0 }), // empty day, heavily penalized
        ...farDates.map((d, i) => capacitySlot(d, { score: 10 + i, stopsThatDay: 2 })),
      ];
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      expect(curatedDates).toContain(nearDate);
      expect(curatedDates).toHaveLength(4);
      // The worst-adjusted-score far pick (farDates[3], score 13) was swapped out.
      expect(curatedDates).not.toContain(farDates[3]);
    });
  });

  test('latency guard: the guaranteed within-horizon slot survives the CLIENT\'s top-3-by-rank slice, not just the server\'s top-4 curated set (Codex r1 P1 on #4926)', async () => {
    await withGate('true', async () => {
      const cutoff = businessDayHorizonEnd(NOW, RESERVICE_LATENCY_BUSINESS_DAYS);
      const nearDate = cutoff;
      const farDates = [dayOffset(20), dayOffset(21), dayOffset(22)];
      // The near-term slot is empty-day-penalized (240) and would rank dead
      // last among the four even after curateSlots guarantees it a SEAT —
      // client/src/components/booking/SchedulePicker.jsx's PickerBestTimes
      // re-sorts the curated 4 by `rank` and shows only the best 3, so a
      // seat alone is not enough; it must also outrank at least one peer.
      const slots = [
        capacitySlot(nearDate, { score: 5, stopsThatDay: 0 }),
        ...farDates.map((d, i) => capacitySlot(d, { score: 10 + i, stopsThatDay: 2 })),
      ];
      const result = await build(slots, { rankProfile: 'reservice' });
      expect(result.slots).toHaveLength(4);
      // Mirror the client's own PickerBestTimes selection exactly.
      const top3ByRank = [...result.slots].sort((a, b) => a.rank - b.rank).slice(0, 3);
      expect(top3ByRank.map((s) => s.date)).toContain(nearDate);
    });
  });

  test('latency guard: the guaranteed slot is NOT nearby but 3 far picks ARE nearby — a rank swap alone cannot rescue it (the client sorts nearby before rank), so the strip is trimmed to 3 to guarantee visibility (pre-push audit P1 on #4926)', async () => {
    await withGate('true', async () => {
      const cutoff = businessDayHorizonEnd(NOW, RESERVICE_LATENCY_BUSINESS_DAYS);
      const nearDate = cutoff;
      const farDates = [dayOffset(20), dayOffset(21), dayOffset(22)];
      const slots = [
        // Empty-day-penalized AND a big detour (not nearby) — a tech has to
        // drive a while to get there, on top of it being a room-for-new-
        // customers day.
        capacitySlot(nearDate, { score: 5, stopsThatDay: 0, detourMinutes: NEARBY_DETOUR_MINUTES + 20 }),
        // Three packed, NEARBY far-out days.
        ...farDates.map((d, i) => capacitySlot(d, { score: 10 + i, stopsThatDay: 2, detourMinutes: 2 })),
      ];
      const result = await build(slots, { rankProfile: 'reservice' });
      // Trimmed to exactly 3 — the client renders every pick it's handed
      // once there is no 4th to truncate.
      expect(result.slots).toHaveLength(3);
      const curatedDates = result.slots.map((s) => s.date);
      expect(curatedDates).toContain(nearDate);
      // Faithfully replicate PickerBestTimes' own comparator (nearby DESC,
      // then rank, then original position) over what the server actually
      // returned, proving the near-term slot is genuinely visible, not
      // merely present in the raw array.
      const isNearby = (s) => s.detour_minutes != null && s.detour_minutes <= NEARBY_DETOUR_MINUTES;
      const visible = [...result.slots]
        .sort((a, b) => (Number(isNearby(b)) - Number(isNearby(a))) || (a.rank - b.rank))
        .slice(0, 3);
      expect(visible.map((s) => s.date)).toContain(nearDate);
    });
  });

  test('an unassigned committed visit that day (a real fixed blocker, per find-time.js capacityGapNeighbours) is NOT treated as an empty day under capacity mode, even though the selected technician\'s own stops_that_day reads 0 (Codex r1 P1 on #4926)', async () => {
    const trulyEmptyDate = dayOffset(10);
    const unassignedVisitDate = dayOffset(11);
    const packedDates = [dayOffset(12), dayOffset(13), dayOffset(14)];
    // An unassigned (technician_id: null) committed visit 09:00-10:00 on
    // unassignedVisitDate — a real customer commitment, but invisible to
    // find-time's own per-technician stops_that_day (fit.arrivals) since it
    // belongs to no technician's route. No anchor on trulyEmptyDate at all.
    loadPackingAnchors.mockResolvedValue([{
      technician_id: null, customer_id: 'cust-unassigned', date: unassignedVisitDate,
      rawStartMin: 540, rawEndMin: 600, expectedEndMin: 600,
      lat: 27.4, lng: -82.4, hold: false,
    }]);
    const slots = [
      capacitySlot(trulyEmptyDate, { score: 1, stopsThatDay: 0 }), // genuinely empty — best raw score
      // Packed right after the unassigned visit (10:00) — zero idle, and
      // find-time reports stopsThatDay: 0 for the SELECTED tech either way.
      capacitySlot(unassignedVisitDate, { score: 2, stopsThatDay: 0, startTime: '10:00' }),
      capacitySlot(packedDates[0], { score: 3, stopsThatDay: 2 }),
      capacitySlot(packedDates[1], { score: 4, stopsThatDay: 2 }),
      capacitySlot(packedDates[2], { score: 6, stopsThatDay: 2 }),
    ];
    await withGate('true', async () => {
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      // The fix: unassignedVisitDate is NOT empty-day-penalized (adjusted
      // score ~2), so it beats every packed day and makes the cut.
      expect(curatedDates).toContain(unassignedVisitDate);
      // trulyEmptyDate has no occupancy at all — still correctly penalized
      // (adjusted score ~241) and excluded despite its raw-score advantage.
      expect(curatedDates).not.toContain(trulyEmptyDate);
    });
  });

  test('gate on + rankProfile "reservice": the offered slot SET (days[].slots) is identical to gate-off — ranking never filters', async () => {
    const slots = [
      capacitySlot(dayOffset(10), { score: 1, stopsThatDay: 0 }),
      capacitySlot(dayOffset(11), { score: 2, stopsThatDay: 2 }),
    ];
    const off = await build(slots, { rankProfile: 'reservice' });
    const on = await withGate('true', () => build(slots, { rankProfile: 'reservice' }));
    const stripped = (days) => days.map((d) => ({ date: d.date, starts: d.slots.map((s) => s.start_time).sort() }));
    expect(stripped(on.days)).toEqual(stripped(off.days));
  });

  test('competing technicians at the same date+start: the packed tech-day beats an empty one with a better raw score (penalty applies before the dedupe)', async () => {
    const date = dayOffset(10);
    const emptyTech = { ...capacitySlot(date, { score: 1, stopsThatDay: 0 }), technician: { id: 'tech-empty' } };
    const packedTech = { ...capacitySlot(date, { score: 2, stopsThatDay: 3, rank: 2 }), technician: { id: 'tech-packed' } };
    const off = await build([emptyTech, packedTech], { rankProfile: 'reservice' });
    const on = await withGate('true', () => build([emptyTech, packedTech], { rankProfile: 'reservice' }));
    const techAt = (res) => res.days.find((d) => d.date === date).slots.map((s) => s.technician_id);
    // Gate off: first (lowest raw score) claim wins, exactly as before.
    expect(off.slots.map((s) => s.technician_id)).toEqual(['tech-empty']);
    expect(on.slots.map((s) => s.technician_id)).toEqual(['tech-packed']);
    // Still one offered slot at that date+start either way — nothing added or hidden.
    expect(techAt(on)).toHaveLength(techAt(off).length);
  });

  test('competing technicians with REAL occupancy anchors: tech-A (packed via a genuine committed visit) beats tech-B (genuinely empty, better raw score) — pre-push audit P1 on #4926', async () => {
    const date = dayOffset(10);
    // A real committed visit belonging ONLY to tech-A, 09:00-10:00 (540-600,
    // immediately before the 10:00 candidate window so idle_minutes lands
    // at 0 — isolating the "not empty" fix from the separate idle-weight
    // math). find-time's OWN per-technician stops_that_day reads 0 for BOTH
    // candidates below (a synthetic mismatch used deliberately, to prove
    // the fix reads real GLOBAL occupancy rather than trusting that field
    // alone) — before the fix, this single tech-A row would have made
    // tech-B's day look occupied too (the bug), letting B's better raw
    // score win the dedupe despite B having nothing on the books that day.
    loadPackingAnchors.mockResolvedValue([{
      technician_id: 'tech-A', customer_id: 'cust-a', date,
      rawStartMin: 540, rawEndMin: 600, expectedEndMin: 600,
      lat: 27.4, lng: -82.4, hold: false,
    }]);
    const techA = capacitySlot(date, { score: 2, stopsThatDay: 0, technicianId: 'tech-A' });
    const techB = capacitySlot(date, { score: 1, stopsThatDay: 0, technicianId: 'tech-B', rank: 2 });
    const result = await withGate('true', () => build([techA, techB], { rankProfile: 'reservice' }));
    expect(result.slots.map((s) => s.technician_id)).toEqual(['tech-A']);
  });
});
