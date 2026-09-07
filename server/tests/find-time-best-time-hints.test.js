/**
 * POST /admin/schedule/find-time — best-time hint gating + param passthrough.
 *
 * What this locks down:
 *  1. hint:true with GATE_BEST_TIME_HINTS off answers gated:true WITHOUT
 *     running the engine (kill-switch contract: pickers render exactly as
 *     today, mirroring dispatch slot-check).
 *  2. hint:true with the gate on runs a single-day search and passes
 *     excludeServiceIds + slotStepMinutes through to the engine.
 *  3. excludeServiceIds / slotStepMinutes validation 400s on garbage.
 *  4. A request WITHOUT the hint flag is NEVER gated — the existing
 *     Find-a-Time button stays ungated regardless of env.
 *  5. The hint occupancy guard: the engine walks per-technician routes, so
 *     technician-null rows are invisible to it — hint mode must veto hours
 *     the tech-blind occupancy snapshot flags, honor excludeServiceIds,
 *     over-fetch then slice to the requested topN, fail OPEN on snapshot
 *     errors, and never run for non-hint requests.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
// Pin ET "now" (12:00 ET, Aug 31 2026) so the same-day picked-hour floor
// test is deterministic; every other test passes explicit past dates.
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z');
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
// The lat/lng request path never geocodes; stubbing keeps the module's DB
// and fetch dependencies out of the suite.
jest.mock('../services/geocoder', () => ({
  geocodeAddress: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
  buildAddress: jest.requireActual('../services/geocoder').buildAddress,
}));
jest.mock('../services/scheduling/find-time', () => ({
  ...jest.requireActual('../services/scheduling/find-time'),
  findAvailableSlots: jest.fn(),
}));
// The arrival-mode picked-hour verdict asks the shared route checker
// directly; the gate helper stays real so the env flag still decides.
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  checkArrivalPlacement: jest.fn(),
}));
// Only the snapshot loader is stubbed — conflictsForTarget stays REAL so
// the guard's overlap semantics are the production ones.
jest.mock('../services/rain-out', () => ({
  ...jest.requireActual('../services/rain-out'),
  loadOccupancy: jest.fn(),
}));

const express = require('express');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadOccupancy } = require('../services/rain-out');
const { checkArrivalPlacement } = require('../services/scheduling/arrival-route');
const findTimeRouter = require('../routes/admin-schedule-find-time');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule/find-time', findTimeRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const ORIGINAL_GATE = process.env.GATE_BEST_TIME_HINTS;
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_BEST_TIME_HINTS;
  else process.env.GATE_BEST_TIME_HINTS = ORIGINAL_GATE;
});

const emptyOccupancy = () => ({ rows: [], canName: () => false, nameById: new Map() });
// Row shape mirrors listOccupiedWindows output (precomputed startMin/endMin).
const occupiedRow = (over = {}) => ({
  id: 'unassigned-1', date: '2026-09-01', startMin: 9 * 60, endMin: 10 * 60,
  customer_id: 'c1', technician_id: null, service_type: 'Pest Control',
  reservation_expires_at: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BEST_TIME_HINTS;
  findAvailableSlots.mockResolvedValue({
    slots: [{ rank: 1, date: '2026-09-01', start_time: '09:00', end_time: '10:00', detour_minutes: 4, stops_that_day: 3 }],
    evaluated: 1,
  });
  loadOccupancy.mockResolvedValue(emptyOccupancy());
});

function post(body) {
  return fetch(`${baseUrl}/admin/schedule/find-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Direct coords skip customer lookup and geocoding entirely.
const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: '2026-09-01', dateTo: '2026-09-01' };

test('hint with the gate off answers gated:true and never touches the engine', async () => {
  const res = await post({ ...BASE, hint: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, gated: true, slots: [] });
  expect(findAvailableSlots).not.toHaveBeenCalled();
});

test('hint with the gate on runs a single-day search with the new params passed through', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const res = await post({
    ...BASE, hint: true, excludeServiceIds: ['svc-1'], slotStepMinutes: 60, topN: 3,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.gated).toBeUndefined();
  expect(body.slots).toHaveLength(1);
  expect(findAvailableSlots).toHaveBeenCalledTimes(1);
  const opts = findAvailableSlots.mock.calls[0][0];
  expect(opts.dateFrom).toBe('2026-09-01');
  expect(opts.dateTo).toBe('2026-09-01');
  expect(opts.excludeServiceIds).toEqual(['svc-1']);
  expect(opts.slotStepMinutes).toBe(60);
  // Hint mode takes the engine's whole bounded list (the occupancy guard
  // can veto entire gaps); the response is sliced back to topN.
  expect(opts.topN).toBe(100);
});

test('garbage excludeServiceIds / slotStepMinutes 400 before the engine runs', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const bad = [
    { excludeServiceIds: 'svc-1' }, // not an array
    { excludeServiceIds: [''] },
    { excludeServiceIds: [{}] },
    { excludeServiceIds: Array.from({ length: 26 }, (_, i) => `s${i}`) }, // over the 25 cap
    { slotStepMinutes: 0 },
    { slotStepMinutes: 121 },
    { slotStepMinutes: 'hourly' },
  ];
  for (const extra of bad) {
    const res = await post({ ...BASE, hint: true, ...extra });
    expect(res.status).toBe(400);
  }
  expect(findAvailableSlots).not.toHaveBeenCalled();
});

test('without the hint flag the search is never gated, regardless of env', async () => {
  for (const gate of [undefined, 'true']) {
    if (gate === undefined) delete process.env.GATE_BEST_TIME_HINTS;
    else process.env.GATE_BEST_TIME_HINTS = gate;
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect((await res.json()).gated).toBeUndefined();
  }
  expect(findAvailableSlots).toHaveBeenCalledTimes(2);
  // The occupancy guard is a hint-mode construct — the ranged button's
  // results must not change shape or cost.
  expect(loadOccupancy).not.toHaveBeenCalled();
});

test('hint vetoes an hour occupied by a technician-null row the engine cannot see', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue({
    slots: [
      { rank: 1, date: '2026-09-01', start_time: '09:00', end_time: '10:00', detour_minutes: 4 },
      { rank: 2, date: '2026-09-01', start_time: '10:00', end_time: '11:00', detour_minutes: 6 },
    ],
    evaluated: 2,
  });
  loadOccupancy.mockResolvedValue({ ...emptyOccupancy(), rows: [occupiedRow()] });
  const res = await post({ ...BASE, hint: true, topN: 3 });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.slots.map((s) => s.start_time)).toEqual(['10:00']);
  expect(loadOccupancy).toHaveBeenCalledWith({ dateFrom: '2026-09-01', dateTo: '2026-09-01' });
});

test('the guard honors excludeServiceIds — a reschedule never collides with its own row', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  loadOccupancy.mockResolvedValue({ ...emptyOccupancy(), rows: [occupiedRow({ id: 'svc-self' })] });
  const res = await post({ ...BASE, hint: true, excludeServiceIds: ['svc-self'] });
  const body = await res.json();
  expect(body.slots.map((s) => s.start_time)).toEqual(['09:00']);
});

test('a vetoed earliest start slides within its gap instead of discarding it', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  // One wide gap: earliest start 09:00, latest viable start 14:00.
  findAvailableSlots.mockResolvedValue({
    slots: [{ rank: 1, date: '2026-09-01', start_time: '09:00', end_time: '10:00', detour_minutes: 4, latest_start_min: 14 * 60 }],
    evaluated: 1,
  });
  loadOccupancy.mockResolvedValue({ ...emptyOccupancy(), rows: [occupiedRow()] });
  const res = await post({ ...BASE, hint: true, slotStepMinutes: 60 });
  const body = await res.json();
  // 09:00 is occupied by the tech-null row; the gap's next aligned start
  // survives with the same detour.
  expect(body.slots.map((s) => [s.start_time, s.end_time, s.detour_minutes])).toEqual([['10:00', '11:00', 4]]);
});

test('technician/time pairs sharing an hour dedupe BEFORE the topN slice', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  // Unscoped search: two techs rank the same 09:00, then a distinct 10:00.
  findAvailableSlots.mockResolvedValue({
    slots: [
      { rank: 1, date: '2026-09-01', start_time: '09:00', end_time: '10:00', detour_minutes: 2, technician: { id: 't1', name: 'A' } },
      { rank: 2, date: '2026-09-01', start_time: '09:00', end_time: '10:00', detour_minutes: 5, technician: { id: 't2', name: 'B' } },
      { rank: 3, date: '2026-09-01', start_time: '10:00', end_time: '11:00', detour_minutes: 6, technician: { id: 't1', name: 'A' } },
    ],
    evaluated: 3,
  });
  const res = await post({ ...BASE, hint: true, topN: 2 });
  const body = await res.json();
  // Without pre-slice dedupe this would answer 09:00 twice and starve the
  // second chip; the best-ranked pair wins each hour.
  expect(body.slots.map((s) => [s.start_time, s.technician.id])).toEqual([['09:00', 't1'], ['10:00', 't1']]);
});

test('serviceId resolves the VISIT\'s stamped coords, never the customer primary', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const db = require('../models/db');
  db.raw = jest.fn((sql) => sql);
  db.mockReturnValue({
    where: () => ({
      leftJoin: () => ({
        first: async () => ({
          lat: 27.11, lng: -82.22,
          address_line1: '9 Rental Way', city: 'Parrish', state: 'FL', zip: '34219',
          visit_customer_id: 'c9', visit_profile_label: null,
        }),
      }),
    }),
  });
  const res = await post({ hint: true, serviceId: 'svc-9', customerId: 'c9', durationMinutes: 60, dateFrom: '2026-09-01', dateTo: '2026-09-01' });
  expect(res.status).toBe(200);
  const opts = findAvailableSlots.mock.calls[0][0];
  expect([opts.lat, opts.lng]).toEqual([27.11, -82.22]);
  expect((await res.json()).target.source).toBe('visit_stamp');
});

test('a divergent coordless stamp geocodes the STAMPED address, not the primary', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const db = require('../models/db');
  const { geocodeAddress } = require('../services/geocoder');
  db.raw = jest.fn((sql) => sql);
  db.mockReturnValue({
    where: () => ({
      leftJoin: () => ({
        first: async () => ({
          lat: null, lng: null,
          address_line1: '9 Rental Way', city: 'Parrish', state: 'FL', zip: '34219',
          visit_customer_id: 'c9', visit_profile_label: null,
        }),
      }),
    }),
  });
  geocodeAddress.mockResolvedValue({ lat: 27.5, lng: -82.4 });
  const res = await post({ hint: true, serviceId: 'svc-9', customerId: 'c9', durationMinutes: 60, dateFrom: '2026-09-01', dateTo: '2026-09-01' });
  expect(res.status).toBe(200);
  expect(geocodeAddress).toHaveBeenCalledWith('9 Rental Way, Parrish, FL, 34219', { cacheOnly: false });
  expect((await res.json()).target.source).toBe('address_geocoded_now');
  const opts = findAvailableSlots.mock.calls[0][0];
  expect([opts.lat, opts.lng]).toEqual([27.5, -82.4]);
});

test('arrival hints ignore stale request coordinates and resolve the saved appointment destination', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const saved = process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  const db = require('../models/db');
  db.raw = jest.fn(sql => sql);
  db.mockReturnValue({
    where: () => ({
      leftJoin: () => ({
        first: async () => ({
          lat: 27.55, lng: -82.4,
          address_line1: '100 Fixture Street', city: 'Parrish', state: 'FL', zip: '34219',
          visit_customer_id: 'fixture-customer', visit_profile_label: null,
        }),
      }),
    }),
  });
  try {
    const res = await post({ ...BASE, serviceId: 'fixture-service', hint: true, arrivalWindows: true });
    expect(res.status).toBe(200);
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ lat: 27.55, lng: -82.4 }));
    expect((await res.json()).target.source).toBe('visit_stamp');
  } finally {
    if (saved === undefined) delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    else process.env.GATE_ADMIN_ARRIVAL_WINDOWS = saved;
  }
});

test('the guard fails OPEN — a snapshot error keeps the engine answer', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  loadOccupancy.mockRejectedValue(new Error('snapshot down'));
  const res = await post({ ...BASE, hint: true });
  expect(res.status).toBe(200);
  expect((await res.json()).slots).toHaveLength(1);
});

test.each([undefined, false, true])('existing-visit arrival routing requires explicit supported-caller opt-in: %s', async (arrivalWindows) => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const res = await post({ ...BASE, serviceId: 'svc-1', hint: true, arrivalWindows });
  expect(res.status).toBe(200);
  const opts = findAvailableSlots.mock.calls[0][0];
  if (arrivalWindows === true) expect(opts.arrivalWindow).toEqual({ serviceId: 'svc-1' });
  else expect(opts).not.toHaveProperty('arrivalWindow');
});

// ── Picked-hour scoring ──────────────────────────────────────────────
// A hint request may carry the hour already in the picker; the answer says
// what THAT hour costs (drive into the stop + what the insertion adds) by
// finding the route gap whose bounds contain it.

const gapSlot = (over = {}) => ({
  rank: 1, date: '2026-09-01', start_time: '09:00', end_time: '10:00',
  detour_minutes: 57, drive_in_minutes: 37, drive_out_minutes: 31, latest_start_min: 9 * 60,
  insertion: { after: 'HQ (start of day)', after_name: null, after_stop_id: null, before: 'Stop B (11:00)', before_stop_id: 's-b' },
  technician: { id: 't1', name: 'A' },
  ...over,
});

test('pickedStart inside a gap answers that gap\'s drive-in leg, origin and detour — and asks the engine for every gap', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue({
    slots: [
      gapSlot(),
      gapSlot({ rank: 2, start_time: '13:00', end_time: '14:00', latest_start_min: 15 * 60, detour_minutes: 4, drive_in_minutes: 12,
        insertion: { after: 'Stop C (13:00)', after_name: 'Stop C', after_stop_id: 's-c', before: 'HQ (end of day)', before_stop_id: null } }),
    ],
    evaluated: 2,
  });
  const res = await post({ ...BASE, hint: true, slotStepMinutes: 60, topN: 3, pickedStart: '14:00' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.picked).toEqual({
    start: '14:00', fits: true, detour_minutes: 4, drive_in_minutes: 12,
    from_home_base: false, from_name: 'Stop C', technician: { id: 't1', name: 'A' },
  });
  // The picked hour can sit in the worst gap of the day, so the engine's
  // whole list is requested (the chips row is still sliced to topN).
  expect(findAvailableSlots.mock.calls[0][0].topN).toBe(100);
  expect(body.slots).toHaveLength(2);
});

test('pickedStart in the first gap reports the home base as the origin', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot()], evaluated: 1 });
  const body = await (await post({ ...BASE, hint: true, slotStepMinutes: 60, pickedStart: '09:00' })).json();
  expect(body.picked).toMatchObject({ fits: true, drive_in_minutes: 37, from_home_base: true, from_name: null, detour_minutes: 57 });
});

test('pickedStart outside every gap does not fit', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot()], evaluated: 1 });
  const body = await (await post({ ...BASE, hint: true, slotStepMinutes: 60, pickedStart: '16:00' })).json();
  expect(body.picked).toEqual({ start: '16:00', fits: false });
});

test('a picked hour the tech-blind occupancy snapshot flags does not fit either', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot({ latest_start_min: 14 * 60 })], evaluated: 1 });
  loadOccupancy.mockResolvedValue({ ...emptyOccupancy(), rows: [occupiedRow()] }); // 09:00–10:00, technician null
  const body = await (await post({ ...BASE, hint: true, slotStepMinutes: 60, pickedStart: '09:00' })).json();
  expect(body.picked).toEqual({ start: '09:00', fits: false });
  // The chips row still slides past the occupied hour as before.
  expect(body.slots[0].start_time).toBe('10:00');
});

test('garbage pickedStart 400s before the engine runs; no pickedStart means no picked key', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const bad = await post({ ...BASE, hint: true, pickedStart: '9am' });
  expect(bad.status).toBe(400);
  expect(findAvailableSlots).not.toHaveBeenCalled();
  const body = await (await post({ ...BASE, hint: true })).json();
  expect(body.picked).toBeUndefined();
  expect(findAvailableSlots.mock.calls[0][0].topN).toBe(100);
});

test('a topN:1 range hint survives three fully occupied gaps and answers the fourth (pre-push P1)', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  // Three single-hour gaps on 09-01, all sitting on tech-null rows; one
  // free gap the next day. With a 3× over-fetch the free gap was never
  // fetched and the range hint vanished.
  findAvailableSlots.mockResolvedValue({
    slots: [
      gapSlot({ rank: 1, start_time: '09:00', end_time: '10:00', latest_start_min: 9 * 60, detour_minutes: 1 }),
      gapSlot({ rank: 2, start_time: '11:00', end_time: '12:00', latest_start_min: 11 * 60, detour_minutes: 2 }),
      gapSlot({ rank: 3, start_time: '13:00', end_time: '14:00', latest_start_min: 13 * 60, detour_minutes: 3 }),
      gapSlot({ rank: 4, date: '2026-09-02', start_time: '10:00', end_time: '11:00', latest_start_min: 10 * 60, detour_minutes: 4 }),
    ],
    evaluated: 4,
  });
  loadOccupancy.mockImplementation(async ({ dateFrom }) => (dateFrom === '2026-09-01'
    ? { ...emptyOccupancy(), rows: [9, 11, 13].map((h) => occupiedRow({ id: `u-${h}`, startMin: h * 60, endMin: (h + 1) * 60 })) }
    : emptyOccupancy()));
  const body = await (await post({ ...BASE, dateTo: '2026-09-04', hint: true, slotStepMinutes: 60, topN: 1 })).json();
  expect(findAvailableSlots.mock.calls[0][0].topN).toBe(100);
  expect(body.slots.map((s) => [s.date, s.start_time])).toEqual([['2026-09-02', '10:00']]);
});

test('sameDayFloorMin is applied while choosing: a topN:1 range answer walks today\'s gap up to the floor instead of losing it', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  // Today (pinned 08-31) has one wide gap opening at 10:00; tomorrow a
  // dearer 09:00. A running-late floor of 14:00 must yield today 14:00.
  // Fresh object per call: the route reassigns result.slots, so one shared
  // mock object would leak the first answer into the second request.
  findAvailableSlots.mockImplementation(async () => ({
    slots: [
      gapSlot({ rank: 1, date: '2026-08-31', start_time: '10:00', end_time: '11:00', latest_start_min: 15 * 60, detour_minutes: 1 }),
      gapSlot({ rank: 2, date: '2026-09-01', start_time: '09:00', end_time: '10:00', latest_start_min: 9 * 60, detour_minutes: 2 }),
    ],
    evaluated: 2,
  }));
  const body = await (await post({ ...BASE, dateFrom: '2026-08-31', dateTo: '2026-09-03', hint: true, slotStepMinutes: 60, topN: 1, sameDayFloorMin: 14 * 60 })).json();
  expect(body.slots.map((s) => [s.date, s.start_time, s.end_time])).toEqual([['2026-08-31', '14:00', '15:00']]);
  // A floor past the gap's last start drops today entirely and the next day answers.
  const late = await (await post({ ...BASE, dateFrom: '2026-08-31', dateTo: '2026-09-03', hint: true, slotStepMinutes: 60, topN: 1, sameDayFloorMin: 16 * 60 })).json();
  expect(late.slots.map((s) => [s.date, s.start_time])).toEqual([['2026-09-01', '09:00']]);
  // Other days are never floored; garbage 400s.
  expect(findAvailableSlots.mock.calls[0][0].topN).toBe(100);
  expect((await post({ ...BASE, hint: true, sameDayFloorMin: '2pm' })).status).toBe(400);
});

test('a picked hour outside the engine\'s day bounds is not scored (no picked key) rather than called a conflict', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot()], evaluated: 1 });
  // 07:00 is before the 08:00 day open; 16:30 + 60 min runs past the
  // 17:00 close. Neither is ever enumerated, so neither is a verdict.
  for (const hour of ['07:00', '16:30']) {
    const body = await (await post({ ...BASE, hint: true, slotStepMinutes: 60, pickedStart: hour })).json();
    expect(body.picked).toBeUndefined();
  }
  // Just inside the bounds and outside every gap: a real "doesn't fit".
  const body = await (await post({ ...BASE, hint: true, slotStepMinutes: 60, pickedStart: '16:00' })).json();
  expect(body.picked).toEqual({ start: '16:00', fits: false });
});

test('a same-day picked hour before the engine\'s now+30 floor is not scored (no picked key), later hours are', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  // ET now is pinned at 12:00 → the engine floors today at 12:30, so a
  // 12:00 pick is absent from its list for reasons that say nothing
  // about the route; a 13:00 pick sits in the returned gap.
  const TODAY = { ...BASE, dateFrom: '2026-08-31', dateTo: '2026-08-31' };
  findAvailableSlots.mockResolvedValue({ slots: [gapSlot({ date: '2026-08-31', start_time: '13:00', end_time: '14:00', latest_start_min: 15 * 60 })], evaluated: 1 });
  const early = await (await post({ ...TODAY, hint: true, slotStepMinutes: 60, pickedStart: '12:00' })).json();
  expect(early.picked).toBeUndefined();
  const later = await (await post({ ...TODAY, hint: true, slotStepMinutes: 60, pickedStart: '13:00' })).json();
  expect(later.picked).toMatchObject({ start: '13:00', fits: true });
});

test('arrival-window mode scores the picked hour with the shared route checker: feasible, unverified (no verdict), verified miss', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const saved = process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  const db = require('../models/db');
  db.raw = jest.fn((sql) => sql);
  db.mockReturnValue({
    where: () => ({
      leftJoin: () => ({
        first: async () => ({
          lat: 27.55, lng: -82.4,
          address_line1: '100 Fixture Street', city: 'Parrish', state: 'FL', zip: '34219',
          visit_customer_id: 'fixture-customer', visit_profile_label: null,
        }),
      }),
    }),
  });
  // The recommendation list is empty in all three cases — it proves nothing.
  findAvailableSlots.mockResolvedValue({ slots: [], evaluated: 0 });
  const req = { ...BASE, serviceId: 'fixture-service', technicianId: 't1', hint: true, arrivalWindows: true, slotStepMinutes: 60, pickedStart: '09:00' };
  try {
    checkArrivalPlacement.mockResolvedValue({ feasible: true, detourMinutes: 9, estimatedArrival: '09:44' });
    let body = await (await post(req)).json();
    expect(body.picked).toEqual({ start: '09:00', fits: true, detour_minutes: 9, drive_in_minutes: null, from_home_base: null, from_name: null, technician: null });
    expect(checkArrivalPlacement).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'fixture-service', date: '2026-09-01', technicianId: 't1', windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60,
    }));
    checkArrivalPlacement.mockResolvedValue({ feasible: false, reason: 'route_unverified' });
    body = await (await post(req)).json();
    expect(body.picked).toBeUndefined();
    checkArrivalPlacement.mockResolvedValue({ feasible: false, reason: 'arrival_window' });
    body = await (await post(req)).json();
    expect(body.picked).toEqual({ start: '09:00', fits: false });
  } finally {
    if (saved === undefined) delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    else process.env.GATE_ADMIN_ARRIVAL_WINDOWS = saved;
  }
});
