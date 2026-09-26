/**
 * GATE_RESERVICE_RANK_AFTER_NEW — re-service slots rank after new customers
 * (owner ruling 2026-09-24: "prefer new customers over existing — new-
 * customer bookings get first pick of open time; re-service/callback
 * pickers rank after"). Structural design (Codex r2 on #4926 — non-
 * convergence on shared curateSlots patching): the profile is NEVER routed
 * through the shared curateSlots/AM-PM-diversity swap and never mutates a
 * candidate's `rank`/`score`. Everything it does lives in two pure
 * functions — curateReserviceStrip (a dedicated, at-most-3, packed-first
 * curator working on copies) and applyReserviceProfile (the ONE call site
 * buildBookingAvailability makes, so the host function carries none of the
 * branching) — plus reserviceStopsThatDay's occupancy-only empty-day
 * signal. Covers all three in isolation, then end to end through
 * buildBookingAvailability: gate off (or no profile) is byte-identical to
 * today; gate on demotes empty-day slots (including hold-only days) and
 * promotes tightly packed ones; a within-5-business-day slot is guaranteed
 * a strip seat; the offered slot SET (days[].slots) is never filtered.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/packing-geometry', () => ({ loadPackingAnchors: jest.fn() }));

const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadPackingAnchors } = require('../services/scheduling/packing-geometry');
const {
  buildBookingAvailability,
  curateSlots,
  reserviceAdjustedScore,
  reserviceRankIsActive,
  reserviceStopsThatDay,
  curateReserviceStrip,
  applyReserviceProfile,
  isReserviceNearbySlot,
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
// each test controls score/date/idle directly without needing a real route
// gap to fan out. `stopsThatDay` here is the RAW find-time value only — once
// occupiedByDate is available (every test below unless noted), the actual
// stored stops_that_day is recomputed from real occupancy anchors
// (reserviceStopsThatDay), so "packed" dates need a matching anchor (see
// packedAnchor below), not just this raw flag.
function capacitySlot(date, { score = 5, stopsThatDay = 0, startTime = '10:00', rank = 1, detourMinutes = 3, technicianId = 'tech-1' } = {}) {
  return {
    date, start_time: startTime, end_time: null,
    technician: { id: technicianId }, detour_minutes: detourMinutes,
    stops_that_day: stopsThatDay, rank, score, insertion: {},
  };
}

// A real committed-visit occupancy row (loadPackingAnchors shape) ending
// exactly at `beforeStartTime` (default '10:00') so idleMinutesAgainst
// clamps to 0 — isolates the empty/not-empty signal from idle-weight math
// unless a test deliberately wants a gap.
function timeToMinLocal(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
function packedAnchor(date, technicianId, { beforeStartTime = '10:00', hold = false } = {}) {
  const endMin = timeToMinLocal(beforeStartTime);
  return {
    technician_id: technicianId, customer_id: 'cust-x', date,
    rawStartMin: endMin - 60, rawEndMin: endMin, expectedEndMin: endMin,
    lat: 27.4, lng: -82.4, hold,
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

describe('reserviceAdjustedScore (pure)', () => {
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
});

describe('businessDayHorizonEnd (pure)', () => {
  test('skips Saturday and Sunday', () => {
    // A known Monday: 2026-09-28 is a Monday (2026-09-26 is a Saturday).
    const monday = parseETDateTime('2026-09-28T12:00');
    // 5 business days after a Monday: Tue,Wed,Thu,Fri,Mon(+1 week) = Oct 5.
    expect(businessDayHorizonEnd(monday, 5)).toBe('2026-10-05');
  });

  test('counts from the NEXT calendar day, not today', () => {
    const monday = parseETDateTime('2026-09-28T12:00');
    expect(businessDayHorizonEnd(monday, 1)).toBe('2026-09-29'); // Tuesday
  });

  test('delegates to the shared addETBusinessDays (server/utils/datetime-et.js), also used by routes/stripe-webhook.js', () => {
    const monday = parseETDateTime('2026-09-28T12:00');
    expect(businessDayHorizonEnd(monday, 5)).toBe(etDateString(addETBusinessDays(monday, 5)));
  });
});

describe('reserviceRankIsActive (pure)', () => {
  test('true only when the profile is "reservice" AND the gate is live', async () => {
    await withGate('true', () => {
      expect(reserviceRankIsActive('reservice')).toBe(true);
    });
  });

  test('false when the profile is not "reservice", gate on or off', async () => {
    await withGate('true', () => {
      expect(reserviceRankIsActive(null)).toBe(false);
      expect(reserviceRankIsActive(undefined)).toBe(false);
      expect(reserviceRankIsActive('book')).toBe(false);
    });
  });

  test('false when the profile is "reservice" but the gate is off/unset', async () => {
    await withGate(null, () => {
      expect(reserviceRankIsActive('reservice')).toBe(false);
    });
  });
});

describe('isReserviceNearbySlot (pure)', () => {
  test('at or under the threshold is nearby, over it is not, null/missing detour is not', () => {
    expect(isReserviceNearbySlot({ detour_minutes: NEARBY_DETOUR_MINUTES })).toBe(true);
    expect(isReserviceNearbySlot({ detour_minutes: NEARBY_DETOUR_MINUTES - 1 })).toBe(true);
    expect(isReserviceNearbySlot({ detour_minutes: NEARBY_DETOUR_MINUTES + 1 })).toBe(false);
    expect(isReserviceNearbySlot({ detour_minutes: null })).toBe(false);
    expect(isReserviceNearbySlot({})).toBe(false);
  });
});

describe('reserviceStopsThatDay (pure) — occupancy-only empty-day signal (#4926)', () => {
  test('occupancy unavailable (map itself null — the fetch failed): falls back to the raw find-time count', () => {
    expect(reserviceStopsThatDay(null, '2026-10-01', 3, 'tech-A')).toBe(3);
    expect(reserviceStopsThatDay(null, '2026-10-01', 0, 'tech-A')).toBe(0);
  });

  test('occupancy available but nothing for this date: empty, regardless of a nonzero raw count (find-time can be wrong)', () => {
    const occupiedByDate = new Map();
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 5, 'tech-A')).toBe(0);
  });

  test('a real committed row for THIS technician: not empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: 'tech-A', hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-A')).toBe(1);
  });

  test('a real committed row for a DIFFERENT technician: still empty for THIS technician', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: 'tech-A', hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-B')).toBe(0);
  });

  test('an unassigned (technician_id: null) committed row: not empty for ANY technician', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: null, hold: false }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-A')).toBe(1);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 0, 'tech-B')).toBe(1);
  });

  // Pre-push audit r2 P1: under GATE_SCHEDULING_CAPACITY, find-time's own
  // stops_that_day (fit.arrivals) counts this technician's own LIVE ESTIMATE
  // HOLDS as real arrivals — a hold-only day is not a committed day and must
  // not dodge the empty-day penalty. Once occupancy is available, raw is
  // NEVER consulted, so a hold-only day is empty even with a raw count > 0.
  test('a hold-only day (find-time raw count contaminated by a live hold, no real customer): still empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [{ technician_id: 'tech-A', hold: true }]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 1, 'tech-A')).toBe(0);
  });

  test('a mix of a hold and a real committed row for this technician: the real row makes it not-empty', () => {
    const occupiedByDate = new Map([['2026-10-01', [
      { technician_id: 'tech-A', hold: true },
      { technician_id: 'tech-A', hold: false },
    ]]]);
    expect(reserviceStopsThatDay(occupiedByDate, '2026-10-01', 1, 'tech-A')).toBe(1);
  });
});

describe('curateReserviceStrip (pure) — dedicated, packed-first, at-most-3 curator (#4926)', () => {
  const nearbyNone = () => false;
  function cand(date, { score = 5, stopsThatDay = 0, idleMinutes = 0, startTime = '10:00', detourMinutes = 3 } = {}) {
    return { date, start_time: startTime, score, stops_that_day: stopsThatDay, idle_minutes: idleMinutes, detour_minutes: detourMinutes };
  }

  test('packed candidates fill all 3 seats before any empty-day candidate is even considered, even when an empty candidate scores lower (better) than some packed ones', () => {
    // adjustedScore: packed = raw score (no penalty); empty = raw + 240.
    const packed = [
      cand('p1', { score: 300, stopsThatDay: 2 }),
      cand('p2', { score: 310, stopsThatDay: 2 }),
      cand('p3', { score: 320, stopsThatDay: 2 }),
      cand('p4', { score: 330, stopsThatDay: 2 }),
    ];
    const empty = cand('e1', { score: 1, stopsThatDay: 0 }); // adjustedScore 241 — beats p3/p4 numerically
    const picks = curateReserviceStrip([...packed, empty], { latencyCutoffDate: null, nearbyFn: nearbyNone });
    expect(picks.map((s) => s.date).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(picks.map((s) => s.date)).not.toContain('e1');
    expect(picks.map((s) => s.date)).not.toContain('p4');
  });

  test('an empty-day candidate only fills a seat still open once every packed date is exhausted', () => {
    const picks = curateReserviceStrip([
      cand('p1', { score: 5, stopsThatDay: 2 }),
      cand('e1', { score: 1, stopsThatDay: 0 }),
      cand('e2', { score: 2, stopsThatDay: 0 }),
    ], { latencyCutoffDate: null, nearbyFn: nearbyNone });
    expect(picks.map((s) => s.date).sort()).toEqual(['e1', 'e2', 'p1']);
  });

  test('at most 3, on distinct dates, even with 5 packed candidates available', () => {
    const packed = [1, 2, 3, 4, 5].map((n) => cand(`p${n}`, { score: n, stopsThatDay: 2 }));
    const picks = curateReserviceStrip(packed, { latencyCutoffDate: null, nearbyFn: nearbyNone });
    expect(picks).toHaveLength(3);
    expect(picks.map((s) => s.date).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  test('latency guard: a within-horizon candidate not otherwise picked replaces the worst pick', () => {
    const cutoff = dayOffset(5);
    const near = cand(dayOffset(3), { score: 50, stopsThatDay: 0 }); // within horizon, empty, weak score
    const far = [dayOffset(20), dayOffset(21), dayOffset(22)].map((d, i) => cand(d, { score: 1 + i, stopsThatDay: 2 }));
    const picks = curateReserviceStrip([...far, near], { latencyCutoffDate: cutoff, nearbyFn: nearbyNone });
    expect(picks.map((s) => s.date)).toContain(near.date);
    expect(picks).toHaveLength(3);
    // The worst (highest adjusted score) of the far picks was replaced.
    expect(picks.map((s) => s.date)).not.toContain(far[2].date);
  });

  test('latency guard: no-op when a within-horizon candidate is already picked', () => {
    const cutoff = dayOffset(5);
    const candidates = [
      cand(dayOffset(2), { score: 1, stopsThatDay: 2 }),
      cand(dayOffset(10), { score: 2, stopsThatDay: 2 }),
      cand(dayOffset(11), { score: 3, stopsThatDay: 2 }),
    ];
    const picks = curateReserviceStrip(candidates, { latencyCutoffDate: cutoff, nearbyFn: nearbyNone });
    expect(picks.map((s) => s.date).sort()).toEqual(candidates.map((c) => c.date).sort());
  });

  test('never mutates the input candidate objects (works on copies)', () => {
    const original = [
      cand('p1', { score: 5, stopsThatDay: 2 }),
      cand('p2', { score: 6, stopsThatDay: 2 }),
    ];
    const snapshot = original.map((c) => ({ ...c }));
    curateReserviceStrip(original, { latencyCutoffDate: null, nearbyFn: nearbyNone });
    expect(original).toEqual(snapshot);
    expect(original.every((c) => !('rank' in c) || c.rank === snapshot.find((s) => s.date === c.date).rank)).toBe(true);
  });

  test('assigns strip-only display ranks 1..N (never present on the input) in the order the given nearbyFn + adjusted score prefer', () => {
    const farButBetterScore = cand('a', { score: 1, stopsThatDay: 2, detourMinutes: 30 });
    const nearWorseScore = cand('b', { score: 5, stopsThatDay: 2, detourMinutes: 3 });
    const picks = curateReserviceStrip([farButBetterScore, nearWorseScore], {
      latencyCutoffDate: null, nearbyFn: isReserviceNearbySlot,
    });
    const byDate = Object.fromEntries(picks.map((p) => [p.date, p]));
    expect(byDate.b.rank).toBe(1); // nearby wins the display order over a better score
    expect(byDate.a.rank).toBe(2);
    expect(picks.every((p) => !('adjustedScore' in p))).toBe(true);
  });
});

describe('applyReserviceProfile (pure, logger mocked)', () => {
  function scored(date, { score = 5, rank = 1, stopsThatDay = 2, idleMinutes = 0, slotSig = `sig-${date}` } = {}) {
    return { date, start_time: '10:00', score, rank, stops_that_day: stopsThatDay, idle_minutes: idleMinutes, slot_sig: slotSig };
  }

  test('inactive (no rankProfile): delegates to curateSlots and is_best_fit uses the legacy rank field', async () => {
    const candidates = [scored(dayOffset(1), { rank: 2, slotSig: 'a' }), scored(dayOffset(2), { rank: 1, slotSig: 'b' })];
    const result = applyReserviceProfile({ rankProfile: null, candidates, today: NOW, totalFeasible: 2 });
    expect(result.diagnostics.active).toBe(false);
    expect(result.slots).toEqual(curateSlots(candidates, NOW));
    expect(result.bestFitByDate.get(dayOffset(1))).toBe('a');
    expect(result.bestFitByDate.get(dayOffset(2))).toBe('b');
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('gate off + rankProfile passed: still inactive, but diagnostics before/after are logged and identical', async () => {
    await withGate(null, () => {
      const candidates = [scored(dayOffset(1)), scored(dayOffset(2))];
      const result = applyReserviceProfile({ rankProfile: 'reservice', candidates, today: NOW, totalFeasible: 2 });
      expect(result.diagnostics.active).toBe(false);
      expect(result.diagnostics.before).toEqual(result.diagnostics.after);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });
  });

  test('active: delegates to curateReserviceStrip and is_best_fit uses the ADJUSTED score, not rank', async () => {
    await withGate('true', () => {
      // Empty day (no stops) but numerically better raw score/rank — the
      // adjusted score must still lose to the packed day for is_best_fit.
      const emptyBetterRank = scored(dayOffset(1), { score: 1, rank: 1, stopsThatDay: 0, slotSig: 'empty' });
      const packedWorseRank = scored(dayOffset(1), { score: 5, rank: 2, stopsThatDay: 2, slotSig: 'packed' });
      const candidates = [emptyBetterRank, packedWorseRank];
      const result = applyReserviceProfile({ rankProfile: 'reservice', candidates, today: NOW, totalFeasible: 2 });
      expect(result.diagnostics.active).toBe(true);
      expect(result.bestFitByDate.get(dayOffset(1))).toBe('packed');
      expect(logger.info).toHaveBeenCalledTimes(1);
    });
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
      // Byte-for-byte proof: gate off routes through the ordinary curateSlots
      // (up to 4 picks), so the raw-best-score empty day is still curated.
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

  test('gate on + rankProfile "reservice": an empty day with the best raw score is demoted out of the (at-most-3) curated strip in favor of packed days', async () => {
    const emptyDate = dayOffset(10);
    const packedDates = [dayOffset(11), dayOffset(12), dayOffset(13)];
    loadPackingAnchors.mockResolvedValue(packedDates.map((d) => packedAnchor(d, 'tech-1')));
    const slots = [
      capacitySlot(emptyDate, { score: 1 }), // best raw score, but genuinely empty (no anchor)
      capacitySlot(packedDates[0], { score: 2 }),
      capacitySlot(packedDates[1], { score: 3 }),
      capacitySlot(packedDates[2], { score: 6 }), // worst raw score, but packed
    ];
    await withGate('true', async () => {
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      expect(curatedDates).not.toContain(emptyDate);
      expect(curatedDates.sort()).toEqual([...packedDates].sort());
      expect(result.slots).toHaveLength(3);
      // The full per-day grid still lists the empty day — nothing is
      // filtered, only the suggested strip's membership changed.
      expect(result.days.map((d) => d.date)).toContain(emptyDate);
      const emptyDay = result.days.find((d) => d.date === emptyDate);
      expect(emptyDay.slots).toHaveLength(1);
    });
  });

  test('gate on + rankProfile "reservice": a slot packed against existing stops (low idle) outranks a same-day slot with a better raw score but a bigger hole', async () => {
    const date = dayOffset(10);
    // One committed stop 09:00-10:00 that day, for tech-1 — makes the WHOLE
    // day not-empty (the signal is per-day, not per-start-time); the
    // idle-minute difference between the two candidates does the rest.
    loadPackingAnchors.mockResolvedValue([packedAnchor(date, 'tech-1', { beforeStartTime: '10:00' })]);
    const slots = [
      // Far from the anchor (16:00) — best RAW score, but leaves a big hole.
      capacitySlot(date, { score: 5, startTime: '16:00', rank: 1 }),
      // Right after the anchor (10:00) — worse raw score, packed tight.
      capacitySlot(date, { score: 8, startTime: '10:00', rank: 2 }),
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
      const farDates = [dayOffset(20), dayOffset(21), dayOffset(22)];
      loadPackingAnchors.mockResolvedValue(farDates.map((d) => packedAnchor(d, 'tech-1')));
      const slots = [
        capacitySlot(nearDate, { score: 5 }), // empty day, heavily penalized
        ...farDates.map((d, i) => capacitySlot(d, { score: 10 + i })),
      ];
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      expect(curatedDates).toContain(nearDate);
      expect(curatedDates).toHaveLength(3);
      // The worst-adjusted-score far pick (farDates[2], score 12) was swapped out.
      expect(curatedDates).not.toContain(farDates[2]);
    });
  });

  test('an unassigned committed visit that day (a real fixed blocker, per find-time.js capacityGapNeighbours) is NOT treated as an empty day, even though the selected technician\'s own stops_that_day reads 0', async () => {
    const trulyEmptyDate = dayOffset(10);
    const unassignedVisitDate = dayOffset(11);
    const packedDates = [dayOffset(12), dayOffset(13)];
    // An unassigned (technician_id: null) committed visit 09:00-10:00 on
    // unassignedVisitDate — a real customer commitment, but invisible to
    // find-time's own per-technician stops_that_day (fit.arrivals) since it
    // belongs to no technician's route. No anchor on trulyEmptyDate at all.
    loadPackingAnchors.mockResolvedValue([
      { technician_id: null, customer_id: 'cust-unassigned', date: unassignedVisitDate,
        rawStartMin: 540, rawEndMin: 600, expectedEndMin: 600, lat: 27.4, lng: -82.4, hold: false },
      ...packedDates.map((d) => packedAnchor(d, 'tech-1')),
    ]);
    const slots = [
      capacitySlot(trulyEmptyDate, { score: 1 }), // genuinely empty — best raw score
      capacitySlot(unassignedVisitDate, { score: 2, startTime: '10:00' }), // packed right after the unassigned visit
      capacitySlot(packedDates[0], { score: 3 }),
      capacitySlot(packedDates[1], { score: 4 }),
    ];
    await withGate('true', async () => {
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      // The fix: unassignedVisitDate is NOT empty-day-penalized (adjusted
      // score ~2), so it beats the packed days and makes the cut.
      expect(curatedDates).toContain(unassignedVisitDate);
      // trulyEmptyDate has no occupancy at all — still correctly penalized
      // (adjusted score ~241) and excluded despite its raw-score advantage.
      expect(curatedDates).not.toContain(trulyEmptyDate);
    });
  });

  test('a hold-only day (find-time raw stops_that_day contaminated by a live estimate hold) is NOT treated as packed — it loses its seat to genuinely packed days despite the best raw score', async () => {
    const holdOnlyDate = dayOffset(10);
    const packedDates = [dayOffset(11), dayOffset(12), dayOffset(13)];
    // find-time (capacity mode) reports stops_that_day: 1 for holdOnlyDate —
    // simulating fit.arrivals counting the technician's own live hold — but
    // the ONLY occupancy row that date is a hold, no real customer. Three
    // genuinely packed competitors mean there are more packed dates than
    // strip seats (3), so the fix is only provable if the hold-only day
    // actually loses one to a real competitor.
    loadPackingAnchors.mockResolvedValue([
      packedAnchor(holdOnlyDate, 'tech-1', { hold: true }),
      ...packedDates.map((d) => packedAnchor(d, 'tech-1')),
    ]);
    const slots = [
      capacitySlot(holdOnlyDate, { score: 1, stopsThatDay: 1 }), // best raw score, "packed" per raw find-time
      capacitySlot(packedDates[0], { score: 3 }),
      capacitySlot(packedDates[1], { score: 4 }),
      capacitySlot(packedDates[2], { score: 6 }), // worst raw score among the real competitors
    ];
    await withGate('true', async () => {
      const result = await build(slots, { rankProfile: 'reservice' });
      const curatedDates = result.slots.map((s) => s.date);
      expect(curatedDates.sort()).toEqual([...packedDates].sort());
      expect(curatedDates).not.toContain(holdOnlyDate);
      // The day grid still lists it — nothing is filtered, only demoted.
      expect(result.days.map((d) => d.date)).toContain(holdOnlyDate);
    });
  });

  test('gate on + rankProfile "reservice": the offered slot SET (days[].slots) is identical to gate-off — ranking never filters', async () => {
    const slots = [
      capacitySlot(dayOffset(10), { score: 1 }),
      capacitySlot(dayOffset(11), { score: 2 }),
    ];
    const off = await build(slots, { rankProfile: 'reservice' });
    const on = await withGate('true', () => build(slots, { rankProfile: 'reservice' }));
    const stripped = (days) => days.map((d) => ({ date: d.date, starts: d.slots.map((s) => s.start_time).sort() }));
    expect(stripped(on.days)).toEqual(stripped(off.days));
  });

  test('competing technicians at the same date+start: the packed tech-day beats an empty one with a better raw score (penalty applies before the dedupe)', async () => {
    const date = dayOffset(10);
    loadPackingAnchors.mockResolvedValue([packedAnchor(date, 'tech-packed')]);
    const emptyTech = capacitySlot(date, { score: 1, technicianId: 'tech-empty' });
    const packedTech = { ...capacitySlot(date, { score: 2, rank: 2, technicianId: 'tech-packed' }) };
    const off = await build([emptyTech, packedTech], { rankProfile: 'reservice' });
    const on = await withGate('true', () => build([emptyTech, packedTech], { rankProfile: 'reservice' }));
    // Gate off: first (lowest raw score) claim wins, exactly as before.
    expect(off.slots.map((s) => s.technician_id)).toEqual(['tech-empty']);
    expect(on.slots.map((s) => s.technician_id)).toEqual(['tech-packed']);
    // Still one offered slot at that date+start either way — nothing added or hidden.
    const techAt = (res) => res.days.find((d) => d.date === date).slots.map((s) => s.technician_id);
    expect(techAt(on)).toHaveLength(techAt(off).length);
  });

  test('competing technicians with REAL occupancy anchors: tech-A (packed via a genuine committed visit) beats tech-B (genuinely empty, better raw score)', async () => {
    const date = dayOffset(10);
    loadPackingAnchors.mockResolvedValue([packedAnchor(date, 'tech-A')]);
    const techA = capacitySlot(date, { score: 2, technicianId: 'tech-A' });
    const techB = capacitySlot(date, { score: 1, technicianId: 'tech-B', rank: 2 });
    const result = await withGate('true', () => build([techA, techB], { rankProfile: 'reservice' }));
    expect(result.slots.map((s) => s.technician_id)).toEqual(['tech-A']);
  });
});
