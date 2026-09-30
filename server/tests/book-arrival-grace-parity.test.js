/**
 * GATE_BOOK_ARRIVAL_GRACE (owner-approved 2026-09-29): /book gets the same
 * arrival grace the estimate picker already uses, and /book's OFFER and
 * COMMIT apply one shared rule (services/scheduling/book-arrival-grace.js).
 *
 * This file drives the REAL pieces end to end, no DB: arrival-route.js's
 * whole-route simulation (evaluateArrivalPlacement over hand-built day
 * contexts, calibrated driving model), find-time.js's capacityGapNeighbours +
 * packCapacityEnds, travel-gap.js, occupancy.js's findConflictingVisits (the
 * commit's strict pre-verify probe, over a fake query builder) and
 * arrival-route.js's arrivalExceedsGrace (verifyArrivalCapacity's bound) —
 * so an offered slot is checked against exactly what createSelfBooking runs,
 * in both directions and with the gate on and off.
 *
 * The synthetic day used throughout (Parrish-style: a 4-stop day whose gaps
 * are tight): tech stops a 09:00, b 11:00, c 13:00, d 16:00, each 60 minutes
 * at spread-out properties; the customer's property sits between b and c.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { evaluateArrivalPlacement, _internals: arrivalInternals } = require('../services/scheduling/arrival-route');
const { _internals: findTimeInternals } = require('../services/scheduling/find-time');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { violatesTravelGap } = require('../services/scheduling/travel-gap');
const { bookGapAdmits, bookClashesWaivable, bookArrivalGraceMinutes } = require('../services/scheduling/book-arrival-grace');
const { etDateString, addETDays } = require('../utils/datetime-et');

const { packCapacityEnds, capacityGapNeighbours, capacityNeighbourEntity } = findTimeInternals;
const DATE = etDateString(addETDays(new Date(), 10));
const TECH = 'tech';

const ENV_KEYS = [
  'GATE_DRIVE_TIME_CALIBRATION', 'GATE_SCHEDULING_CAPACITY', 'GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES',
  'SELF_SERVE_ARRIVAL_GRACE_MINUTES', 'GATE_BOOK_ARRIVAL_GRACE', 'GATE_BOOK_CAPACITY_COMMIT',
];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
  process.env.GATE_BOOK_ARRIVAL_GRACE = 'true';
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '120';
  db.raw = jest.fn((sql) => sql);
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const stop = (id, startHour, lat, lng, extra = {}) => ({
  id, technician_id: TECH, scheduled_date: DATE, status: 'confirmed', customer_id: `cust-${id}`,
  window_start: hh(startHour * 60), window_end: hh(startHour * 60 + 60), estimated_duration_minutes: 60,
  lat, lng, route_order: null, created_at: '2020-01-01T12:00:00Z', ...extra,
});
const FOUR_STOP_DAY = () => [
  stop('a', 9, 27.60, -82.40),
  stop('b', 11, 27.55, -82.42),
  stop('c', 13, 27.50, -82.44),
  stop('d', 16, 27.45, -82.46),
];
const CUSTOMER = { lat: 27.53, lng: -82.43 };

function contextFor(rows, at = CUSTOMER) {
  return {
    date: DATE, now: new Date(), grouped: false, prospective: true, rows,
    target: {
      id: '__candidate__', technician_id: TECH, scheduled_date: DATE, lat: at.lat, lng: at.lng,
      estimated_duration_minutes: 60, service_type: 'Pest Control', route_order: null,
      created_at: new Date().toISOString(),
    },
  };
}
const placement = (startHour) => ({
  windowStart: hh(startHour * 60), windowEnd: hh(startHour * 60 + 60), durationMinutes: 60, bufferMinutes: 0,
});

// find-time's own enumeration, reduced to what packCapacityEnds reads: every
// whole hour the simulation certifies, stamped with the fit's arrival delay
// and the day's real route neighbours (findCapacitySlots does exactly this).
function enumerateSlots(context, hours = [9, 10, 11, 12, 13, 14, 15, 16]) {
  const slots = [];
  for (const hour of hours) {
    const fit = evaluateArrivalPlacement(context, placement(hour));
    if (!fit.feasible) continue;
    slots.push({
      date: DATE, technician: { id: TECH }, start_time: hh(hour * 60), end_time: hh(hour * 60 + 60),
      arrival_delay_minutes: fit.arrivalDelayMinutes, route_mode: 'arrival_windows',
      _gap: capacityGapNeighbours(context, fit, hour * 60),
    });
  }
  return slots;
}
const CALLER = { lat: CUSTOMER.lat, lng: CUSTOMER.lng, durationMinutes: 60, expectedMinutes: 60 };
const starts = (slots) => slots.map((s) => s.start_time);

// The mirror routes/booking.js's addCandidate applies, on the same anchor
// shape (loadPackingAnchors / listOccupiedWindows rows).
function mirrorRows(rows) {
  return rows.map((r) => {
    const s = Number(r.window_start.slice(0, 2)) * 60;
    return {
      technician_id: r.technician_id, customer_id: r.customer_id, startMin: s, endMin: s + 60,
      windowMinutes: 60, expectedMinutes: 60, lat: r.lat, lng: r.lng,
      hold: r.reservation_expires_at != null && r.customer_id == null,
    };
  });
}
const candidateEntity = (slot) => ({
  startMin: Number(slot.start_time.slice(0, 2)) * 60, endMin: Number(slot.start_time.slice(0, 2)) * 60 + 60,
  lat: CUSTOMER.lat, lng: CUSTOMER.lng, windowMinutes: 60, expectedMinutes: 60,
});
const offerMirrorAdmits = (slot, rows, grace) => bookGapAdmits(candidateEntity(slot), mirrorRows(rows), {
  technicianId: slot.technician.id, grace, arrivalDelayMinutes: slot.arrival_delay_minutes,
});
const strictMirrorAdmits = (slot, rows) => !violatesTravelGap(candidateEntity(slot), mirrorRows(rows));

function makeQuery(result = []) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) { if (typeof arg === 'function') arg.call(builder, builder); return builder; }),
    whereNotIn: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    orWhereNull: jest.fn().mockReturnThis(),
    orWhereNot: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  });
  return builder;
}
const dbRow = (r) => ({
  id: r.id, customer_id: r.customer_id, technician_id: r.technician_id, scheduled_date: DATE,
  window_start: `${r.window_start}:00`, window_end: `${r.window_end}:00`, status: r.status,
  service_type: null, service_key_snapshot: null, estimated_duration_minutes: 60,
  reservation_expires_at: r.reservation_expires_at || null, reservation_service_mix: null,
  lat: r.lat, lng: r.lng,
});

// createSelfBooking's commit gate, in its own order: the strict pre-verify
// travel probe (a clash is tolerated only for a graced offer's waivable
// previous-side buffer, and only with a prepared capacity proof), then
// verifyArrivalCapacity's evaluation + grace bound.
async function commitVerdict(rows, slot, offerGrace, context = contextFor(rows)) {
  db.mockReturnValue(makeQuery(rows.map(dbRow)));
  const hour = Number(slot.start_time.slice(0, 2));
  const clashes = await findConflictingVisits({
    db, includeInterviews: false, date: DATE, windowStart: hh(hour * 60), windowEnd: hh(hour * 60 + 60),
    travel: { lat: CUSTOMER.lat, lng: CUSTOMER.lng, expectedMinutes: 60 },
  });
  if (clashes.length && !(offerGrace > 0 && bookClashesWaivable(clashes, { technicianId: TECH, grace: offerGrace, candidateStartMin: hour * 60 }))) {
    return { ok: false, why: `probe:${clashes.map((c) => `${c.id}/${c.conflict_reason}/${Number(c.window_start.slice(0, 2)) * 60 < hour * 60 ? 'before' : 'after'}`).join(',')}` };
  }
  const fit = evaluateArrivalPlacement(context, placement(hour));
  if (!fit.feasible) return { ok: false, why: fit.reason };
  if (arrivalInternals.arrivalExceedsGrace(fit, offerGrace > 0 ? offerGrace : undefined)) return { ok: false, why: 'arrival_grace' };
  return { ok: true };
}

describe('the 4-stop day: find-time vs /book agree (packCapacityEnds checks BOTH neighbours)', () => {
  test('sanity: the simulation certifies every free-ish hour, so the difference is purely the gap rule', () => {
    const slots = enumerateSlots(contextFor(FOUR_STOP_DAY()));
    expect(starts(slots)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00']);
  });

  test('BEFORE: the default pick tests each side against ONE neighbour, so it kept 09:00/11:00/14:00/15:00 — and /book\'s own both-neighbour mirror then dropped every one (an empty day find-time believed had 4)', () => {
    const rows = FOUR_STOP_DAY();
    const slots = enumerateSlots(contextFor(rows));
    const legacy = packCapacityEnds(slots, CALLER);
    expect(starts(legacy)).toEqual(['09:00', '11:00', '14:00', '15:00']);
    expect(legacy.filter((s) => strictMirrorAdmits(s, rows))).toEqual([]);
  });

  test('AFTER (gate on): find-time packs against both neighbours under the shared rule — only 14:00 (right after c, 2h clear of d) survives, and /book\'s mirror keeps it', () => {
    const rows = FOUR_STOP_DAY();
    const packed = packCapacityEnds(enumerateSlots(contextFor(rows)), { ...CALLER, bookArrivalGrace: true });
    expect(starts(packed)).toEqual(['14:00']);
    expect(packed.every((s) => offerMirrorAdmits(s, rows, bookArrivalGraceMinutes({ date: DATE })))).toBe(true);
  });

  test('every candidate the both-neighbour pass keeps is one the mirror admits, for grace 0 / 30 / 120 (find-time and /book cannot disagree)', () => {
    for (const graceMinutes of ['0', '30', '120']) {
      process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = graceMinutes;
      const rows = FOUR_STOP_DAY();
      const packed = packCapacityEnds(enumerateSlots(contextFor(rows)), { ...CALLER, bookArrivalGrace: true });
      for (const slot of packed) expect(offerMirrorAdmits(slot, rows, Number(graceMinutes))).toBe(true);
    }
  });

  test('grace 0 (env unset / same-day / gate off) is exactly the strict rule: nothing on this tight day, matching the strict mirror', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '0';
    const rows = FOUR_STOP_DAY();
    const packed = packCapacityEnds(enumerateSlots(contextFor(rows)), { ...CALLER, bookArrivalGrace: true });
    expect(packed).toEqual([]);
    expect(enumerateSlots(contextFor(rows)).filter((s) => strictMirrorAdmits(s, rows))).toEqual([]);
  });

  test('opt-in required: a caller without bookArrivalGrace still gets the unchanged default pick, whatever the env says', () => {
    const slots = enumerateSlots(contextFor(FOUR_STOP_DAY()));
    expect(starts(packCapacityEnds(slots, CALLER))).toEqual(['09:00', '11:00', '14:00', '15:00']);
    expect(starts(packCapacityEnds(slots, { ...CALLER, bookArrivalGrace: false }))).toEqual(['09:00', '11:00', '14:00', '15:00']);
  });
});

describe('offer/commit parity on the 4-stop day (gate on)', () => {
  test('a mid-day insertion is OFFERED with the gate on and COMMITS: 14:00 right after c passes the waived-buffer probe, the whole-route simulation and the grace bound', async () => {
    const rows = FOUR_STOP_DAY();
    const [slot] = packCapacityEnds(enumerateSlots(contextFor(rows)), { ...CALLER, bookArrivalGrace: true });
    expect(slot.start_time).toBe('14:00');
    expect(await commitVerdict(rows, slot, 120)).toEqual({ ok: true });
  });

  test('the SAME slot with the gate off is neither offered (grace 0 → strict) nor committable (strict probe refuses the previous-side buffer)', async () => {
    const rows = FOUR_STOP_DAY();
    const slot = enumerateSlots(contextFor(rows)).find((s) => s.start_time === '14:00');
    expect(strictMirrorAdmits(slot, rows)).toBe(false);
    const verdict = await commitVerdict(rows, slot, 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/^probe:c\/travel_gap\/before$/);
  });

  test('every offered slot commits, and every slot the commit refuses is not offered — over grace 0/30/120', async () => {
    for (const graceMinutes of [0, 30, 120]) {
      process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = String(graceMinutes);
      const rows = FOUR_STOP_DAY();
      const all = enumerateSlots(contextFor(rows));
      const offered = packCapacityEnds(all, { ...CALLER, bookArrivalGrace: true });
      for (const slot of all) {
        const commit = await commitVerdict(rows, slot, graceMinutes);
        const isOffered = offered.includes(slot);
        // Direction 1: offered => committable.
        if (isOffered) expect(commit).toEqual({ ok: true });
        // Direction 2: not committable => not offered.
        if (!commit.ok) expect(isOffered).toBe(false);
      }
    }
  });

  test('the next stop\'s side is never waived: 15:00 (touching d at 16:00) is refused by the offer AND the commit probe, even at grace 120', async () => {
    const rows = FOUR_STOP_DAY();
    const slot = enumerateSlots(contextFor(rows)).find((s) => s.start_time === '15:00');
    expect(offerMirrorAdmits(slot, rows, 120)).toBe(false);
    const verdict = await commitVerdict(rows, slot, 120);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/d\/travel_gap\/after/);
  });

  test('a real window overlap is never waived: 11:00 lands on b — refused on both sides', async () => {
    const rows = FOUR_STOP_DAY();
    const slot = enumerateSlots(contextFor(rows)).find((s) => s.start_time === '11:00');
    expect(offerMirrorAdmits(slot, rows, 120)).toBe(false);
    const verdict = await commitVerdict(rows, slot, 120);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/b\/overlap/);
  });
});

describe('arrival windows of existing stops would break, or the delay passes grace: not offered AND not committable', () => {
  // Stops x 12:00, y 13:00, z 14:00, w 15:00 back-to-back near the north; the
  // customer is far south. An 11:00 visit right before x makes the whole
  // afternoon slip past a later stop's two-hour promise.
  const AFTERNOON = () => [
    stop('x', 12, 27.60, -82.40), stop('y', 13, 27.61, -82.40),
    stop('z', 14, 27.62, -82.40), stop('w', 15, 27.63, -82.40),
  ];
  const FAR_SOUTH = { lat: 27.0, lng: -82.42 };

  test('11:00 far south: the simulation refuses it (arrival_window), so find-time never emits it and the commit evaluation refuses it too', async () => {
    const rows = AFTERNOON();
    const context = contextFor(rows, FAR_SOUTH);
    expect(evaluateArrivalPlacement(context, placement(11))).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(starts(enumerateSlots(context, [8, 9, 10, 11]))).not.toContain('11:00');
    // The commit refuses it — by the strict next-stop probe first (x starts
    // right as this visit ends; never waived), and, were that probe absent,
    // by the whole-route evaluation above. Neither path can accept it.
    const verdict = await commitVerdict(rows, { start_time: '11:00', technician: { id: TECH } }, 120, context);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/^probe:x\/travel_gap\/after$/);
  });

  test('a delay past the grace: 10:00 on the 4-stop day arrives ~17 minutes late — at grace 10 it is dropped from the offer and the commit refuses it with arrival_grace; at grace 120 both accept the delay itself', async () => {
    const rows = FOUR_STOP_DAY();
    const context = contextFor(rows);
    const tenAm = enumerateSlots(context).find((s) => s.start_time === '10:00');
    expect(tenAm.arrival_delay_minutes).toBeGreaterThan(10);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '10';
    expect(starts(packCapacityEnds(enumerateSlots(context), { ...CALLER, bookArrivalGrace: true }))).not.toContain('10:00');
    // Isolate the bound from the probe: the strict clash for 10:00 is against
    // b (next side) anyway, so run the capacity half directly.
    const fit = evaluateArrivalPlacement(context, placement(10));
    expect(arrivalInternals.arrivalExceedsGrace(fit, 10)).toBe(true);
    expect(arrivalInternals.arrivalExceedsGrace(fit, 120)).toBe(false);
  });
});

describe('the waiver rule itself (bookGapAdmits / bookClashesWaivable)', () => {
  const at = { lat: 27.4, lng: -82.4 };
  const candidate = { startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 60, ...at }; // 10:00-11:00
  const prev = (extra = {}) => ({ startMin: 540, endMin: 600, windowMinutes: 60, expectedMinutes: 60, ...at, technician_id: TECH, hold: false, ...extra });
  const next = (extra = {}) => ({ startMin: 780, endMin: 840, windowMinutes: 60, expectedMinutes: 60, ...at, technician_id: TECH, hold: false, ...extra });
  const ctx = (extra = {}) => ({ technicianId: TECH, grace: 90, arrivalDelayMinutes: 6, ...extra });

  test('previous assigned committed stop, delay within grace: waived', () => {
    expect(bookGapAdmits(candidate, [prev()], ctx())).toBe(true);
  });
  test('gate on the travel-gap rule but grace 0 / delay past grace / unknown delay: strict', () => {
    expect(bookGapAdmits(candidate, [prev()], ctx({ grace: 0 }))).toBe(false);
    expect(bookGapAdmits(candidate, [prev()], ctx({ arrivalDelayMinutes: 91 }))).toBe(false);
    expect(bookGapAdmits(candidate, [prev()], ctx({ arrivalDelayMinutes: undefined }))).toBe(false);
  });
  test('an unassigned stop, another technician\'s stop and a live hold are never waived', () => {
    expect(bookGapAdmits(candidate, [prev({ technician_id: null })], ctx())).toBe(false);
    expect(bookGapAdmits(candidate, [prev({ technician_id: 'someone-else' })], ctx())).toBe(false);
    expect(bookGapAdmits(candidate, [prev({ hold: true })], ctx())).toBe(false);
  });
  test('a hold that is NOT the immediate neighbour still blocks the waiver (a hold is a promise, not a fixed stop)', () => {
    const buriedHold = { startMin: 480, endMin: 605, windowMinutes: 125, expectedMinutes: 125, ...at, technician_id: TECH, hold: true };
    // prev (09:00-10:00) is the latest-ending committed stop; the hold overlaps the candidate's start.
    expect(bookGapAdmits(candidate, [buriedHold, prev()], ctx())).toBe(false);
  });
  test('a next-side buffer violation is never waived', () => {
    const nearNext = next({ startMin: 660, endMin: 720 }); // touches the candidate's end
    expect(bookGapAdmits(candidate, [nearNext], ctx())).toBe(false);
    expect(bookGapAdmits(candidate, [prev(), nearNext], ctx())).toBe(false);
  });
  test('no conflict at all: admitted with or without grace; travel-gap gate off: nothing to waive', () => {
    expect(bookGapAdmits(candidate, [next()], ctx({ grace: 0 }))).toBe(true);
    process.env.GATE_SLOT_TRAVEL_GAP = 'false';
    expect(bookGapAdmits(candidate, [prev({ endMin: 660 })], ctx({ grace: 0 }))).toBe(true);
  });
  test('commit side: only previous-side travel_gap rows on the same assigned technician are waivable', () => {
    const row = (extra = {}) => ({
      id: 'r', technician_id: TECH, customer_id: 'c', reservation_expires_at: null,
      conflict_reason: 'travel_gap', window_start: '09:00:00', ...extra,
    });
    const ctxc = { technicianId: TECH, grace: 90, candidateStartMin: 600 };
    expect(bookClashesWaivable([row()], ctxc)).toBe(true);
    expect(bookClashesWaivable([row()], { ...ctxc, grace: 0 })).toBe(false);
    expect(bookClashesWaivable([row()], { ...ctxc, candidateStartMin: undefined })).toBe(false);
    expect(bookClashesWaivable([], ctxc)).toBe(false);
    expect(bookClashesWaivable([row({ window_start: '11:00:00' })], ctxc)).toBe(false); // next side
    expect(bookClashesWaivable([row({ conflict_reason: 'overlap' })], ctxc)).toBe(false);
    expect(bookClashesWaivable([row({ conflict_reason: 'interview', window_start: '09:00' })], ctxc)).toBe(false);
    expect(bookClashesWaivable([row({ technician_id: null })], ctxc)).toBe(false);
    expect(bookClashesWaivable([row({ technician_id: 'other' })], ctxc)).toBe(false);
    expect(bookClashesWaivable([row({ customer_id: null, reservation_expires_at: '2099-01-01T00:00:00Z' })], ctxc)).toBe(false);
    expect(bookClashesWaivable([row(), row({ id: 'r2', window_start: '11:00:00' })], ctxc)).toBe(false);
  });
});

describe('packCapacityEnds book mode — both-neighbour pick (synthetic gap)', () => {
  const at = { lat: 27.4, lng: -82.4 };
  const dayRow = (id, startMin, endMin) => ({
    id, startMin, endMin, technician_id: TECH, ...at, windowMinutes: endMin - startMin, expectedMinutes: endMin - startMin,
  });
  // prev 09:00-10:00, next 14:00-15:00 — a 4-hour gap, whole-hour candidates 10:00-13:00.
  const dayRows = [dayRow('prev', 540, 600), dayRow('next', 840, 900)];
  const slot = (startHour, delay = 5) => ({
    date: DATE, technician: { id: TECH }, start_time: hh(startHour * 60), end_time: hh(startHour * 60 + 60),
    arrival_delay_minutes: delay,
    _gap: { prevId: 'prev', nextId: 'next', prevRow: dayRows[0], nextRow: dayRows[1], holdRows: [], dayRows },
  });

  test('the earliest candidate that clears BOTH neighbours is the prev-side pick and the latest is the next-side pick', () => {
    const kept = packCapacityEnds([10, 11, 12, 13].map((h) => slot(h)), { ...CALLER, bookArrivalGrace: true });
    // 10:00 touches prev (buffer waived within grace), 13:00 touches next (never waived).
    expect(starts(kept)).toEqual(['10:00', '12:00']);
  });

  test('a candidate that clears only ITS OWN neighbour no longer wins the pick', () => {
    // A 2-hour gap: only 10:00 (prev's buffer waived, then clear of next) can
    // work; 11:00 touches next. The default pick keeps BOTH — its prev-side
    // pick (earliest clearing prev alone) is 11:00 and its next-side pick
    // (latest clearing next alone) is 10:00, each crowding the far neighbour.
    const tightDayRows = [dayRow('prev', 540, 600), dayRow('next', 720, 780)]; // 2-hour gap: only 10:00 (waived) / 11:00
    const tight = (h) => ({ ...slot(h), _gap: { prevId: 'prev', nextId: 'next', prevRow: tightDayRows[0], nextRow: tightDayRows[1], holdRows: [], dayRows: tightDayRows } });
    const slots = [tight(10), tight(11)];
    const legacy = packCapacityEnds(slots, CALLER);
    expect(starts(legacy).sort()).toEqual(['10:00', '11:00']);
    expect(starts(packCapacityEnds(slots, { ...CALLER, bookArrivalGrace: true }))).toEqual(['10:00']);
  });

  test('a stop assigned to another technician is not this route\'s neighbour', () => {
    const rows = [{ ...dayRow('prev', 540, 600), technician_id: 'other-tech' }, dayRows[1]];
    const s = { ...slot(11), _gap: { prevId: 'prev', nextId: 'next', prevRow: rows[0], nextRow: rows[1], holdRows: [], dayRows: rows } };
    expect(starts(packCapacityEnds([s], { ...CALLER, bookArrivalGrace: true }))).toEqual(['11:00']);
  });

  test('an empty day (no real neighbours) keeps every admitted hour', () => {
    const open = (h) => ({ ...slot(h), _gap: { prevId: null, nextId: null, prevRow: null, nextRow: null, holdRows: [], dayRows: [] } });
    expect(starts(packCapacityEnds([9, 10, 11].map(open), { ...CALLER, bookArrivalGrace: true }))).toEqual(['09:00', '10:00', '11:00']);
  });
});

describe('the gate: GATE_BOOK_ARRIVAL_GRACE ships OFF and reads at call time', () => {
  const featureGates = require('../config/feature-gates');
  test('default off; on only with the env value; the grace it yields also needs capacity mode and a non-same-day date', () => {
    delete process.env.GATE_BOOK_ARRIVAL_GRACE;
    expect(featureGates.bookArrivalGraceLive()).toBe(false);
    expect(bookArrivalGraceMinutes({ date: DATE })).toBe(0);
    process.env.GATE_BOOK_ARRIVAL_GRACE = 'true';
    expect(featureGates.bookArrivalGraceLive()).toBe(true);
    expect(bookArrivalGraceMinutes({ date: DATE })).toBe(120);
    // clamped to the 120-minute arrival promise, like the estimate picker
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '500';
    expect(bookArrivalGraceMinutes({ date: DATE })).toBe(120);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '45';
    expect(bookArrivalGraceMinutes({ date: DATE })).toBe(45);
    // never for a same-day pick
    expect(bookArrivalGraceMinutes({ date: etDateString(new Date()) })).toBe(0);
    // capacity mode off: nothing to judge grace by
    delete process.env.GATE_SCHEDULING_CAPACITY;
    expect(bookArrivalGraceMinutes({ date: DATE })).toBe(0);
  });

  test('the logGateStatus map lists it, off by default', () => {
    delete process.env.GATE_BOOK_ARRIVAL_GRACE;
    jest.isolateModules(() => {
      expect(require('../config/feature-gates').gates.bookArrivalGrace).toBe(false);
    });
  });
});

describe('capacityNeighbourEntity is unchanged (no technician/hold fields leak into the estimate path)', () => {
  test('shape', () => {
    expect(capacityNeighbourEntity({ startMin: 540, endMin: 600, lat: 1, lng: 2, expectedMinutes: 45, technician_id: 't' }))
      .toEqual({ startMin: 540, endMin: 600, lat: 1, lng: 2, windowMinutes: 60, expectedMinutes: 45 });
  });
});
