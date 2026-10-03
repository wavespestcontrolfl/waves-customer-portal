/**
 * POST /admin/schedule/find-time — hint summary mode (the reschedule
 * availability strip's data), behind GATE_RESCHEDULE_AVAILABILITY.
 *
 * What this locks down:
 *  1. With the summary gate OFF the flag is ignored: no `summary`, the same
 *     top-N slots, and a picked verdict with no `reason` — the three-line
 *     hint's contract is untouched.
 *  2. With it ON the answer carries one row per date in the searched range,
 *     empty days included, each empty day's status taken from the engine's
 *     per-date refusal reasons; the engine-internal counts never leave.
 *  3. The search is capped at 14 days however wide the request.
 *  4. The picked hour's verdict is scored on `pickedDate` (a summary search
 *     starts days before the pick) and names its reason; an hour no verdict
 *     can cover answers fits:null, never fits:false.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
// Pin ET "now" (12:00 ET, Aug 31 2026).
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
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/geocoder', () => ({
  geocodeAddress: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
  buildAddress: jest.requireActual('../services/geocoder').buildAddress,
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
jest.mock('../services/technician-eligibility', () => ({ absentTechDays: jest.fn(async () => new Set()) }));
jest.mock('../services/scheduling/find-time', () => ({
  ...jest.requireActual('../services/scheduling/find-time'),
  findAvailableSlots: jest.fn(),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  checkArrivalPlacement: jest.fn(),
}));
jest.mock('../services/rain-out', () => ({
  ...jest.requireActual('../services/rain-out'),
  loadOccupancy: jest.fn(),
}));

const express = require('express');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadOccupancy } = require('../services/rain-out');
const { checkArrivalPlacement } = require('../services/scheduling/arrival-route');
const {
  summarizeHintDays, summaryRangeEnd, hintSearchPlan, SUMMARY_MAX_DAYS,
} = require('../services/scheduling/find-time-hints');
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

const GATES = ['GATE_BEST_TIME_HINTS', 'GATE_RESCHEDULE_AVAILABILITY', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_SCHEDULING_CAPACITY'];
const ORIGINAL = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
afterAll(() => {
  for (const name of GATES) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

const emptyOccupancy = () => ({ rows: [], canName: () => false, nameById: new Map() });
const TECH = { id: 't1', name: 'Fixture Tech' };
// Rank-sorted, as the engine returns it: cheapest detour first.
const slot = (date, start, detour, over = {}) => ({
  date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  detour_minutes: detour, drive_in_minutes: 5, drive_out_minutes: 5, stops_that_day: 3, technician: TECH, ...over,
});
const ENGINE = () => ({
  slots: [
    slot('2026-09-03', '11:00', 2),
    slot('2026-09-01', '14:00', 4),
    slot('2026-09-01', '09:00', 11),
    slot('2026-09-03', '09:00', 20),
  ],
  evaluated: 40,
  rejections: { arrival_window: 9 },
  rejections_by_date: {
    '2026-09-02': { day_overcommitted: 4, arrival_window: 5 },
    '2026-09-04': { route_unverified: 10 },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of GATES) delete process.env[name];
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue(ENGINE());
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
const BASE = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, hint: true, slotStepMinutes: 60,
  dateFrom: '2026-09-01', dateTo: '2026-09-05',
};

test('summary gate off: the flag is ignored and the plain hint answers', async () => {
  const res = await post({ ...BASE, summary: true, topN: 1, pickedDate: '2026-09-03', pickedStart: '13:00' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.summary).toBeUndefined();
  expect(body.slots).toHaveLength(1);
  // Verdict scored on dateFrom, as the plain hint always has, with no reason.
  expect(body.picked).toEqual({ start: '13:00', fits: false });
});

test('summary gate on: one row per date, empty days carry a status, hours in clock order', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  const res = await post({ ...BASE, summary: true, topN: 1 });
  expect(res.status).toBe(200);
  const body = await res.json();
  // `slots` keeps the plain hint's ranked top-N.
  expect(body.slots).toHaveLength(1);
  expect(body.slots[0]).toEqual(expect.objectContaining({ date: '2026-09-03', start_time: '11:00' }));
  expect(body.summary.days.map((day) => [day.date, day.status, day.hours.map((hour) => hour.start_time)])).toEqual([
    ['2026-09-01', 'open', ['09:00', '14:00']],
    ['2026-09-02', 'overcommitted', []],
    ['2026-09-03', 'open', ['09:00', '11:00']],
    ['2026-09-04', 'unverified', []],
    ['2026-09-05', 'full', []],
  ]);
  expect(body.summary.days[0].hours[0]).toEqual({
    start_time: '09:00', end_time: '10:00', detour_minutes: 11, estimated_arrival: null,
    stops_that_day: 3, technician: TECH,
  });
  expect(typeof body.summary.elapsed_ms).toBe('number');
  // Engine-internal counts stay inside.
  expect(body.rejections_by_date).toBeUndefined();
});

test('gap mode lists every start in a multi-hour gap, vetoing only the occupied hours', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  // The gap engine emits ONE candidate per route gap: earliest start plus
  // latest_start_min. A free 09:00–13:00 gap fits a one-hour visit at 9, 10,
  // 11 and 12.
  findAvailableSlots.mockResolvedValue({
    slots: [slot('2026-09-01', '09:00', 4, { latest_start_min: 12 * 60 })], evaluated: 1,
  });
  loadOccupancy.mockResolvedValue({
    ...emptyOccupancy(),
    rows: [{
      id: 'unassigned-1', date: '2026-09-01', startMin: 10 * 60, endMin: 11 * 60, customer_id: 'c1',
      technician_id: null, service_type: 'Pest Control', reservation_expires_at: null,
    }],
  });
  let body = await (await post({ ...BASE, dateTo: '2026-09-01', summary: true, topN: 3 })).json();
  expect(body.summary.days[0].hours.map((hour) => [hour.start_time, hour.end_time, hour.detour_minutes])).toEqual([
    ['09:00', '10:00', 4], ['11:00', '12:00', 4], ['12:00', '13:00', 4],
  ]);
  // The ranked top-N stays one start per gap, as the plain hint answers.
  expect(body.slots.map((s) => s.start_time)).toEqual(['09:00']);
  // Both lists come from one guard pass: the day's occupancy is read once.
  expect(loadOccupancy).toHaveBeenCalledTimes(1);
  // Occupancy snapshot down: fail open, every start in the gap listed.
  loadOccupancy.mockRejectedValue(new Error('snapshot unavailable'));
  body = await (await post({ ...BASE, dateTo: '2026-09-01', summary: true })).json();
  expect(body.summary.days[0].hours.map((hour) => hour.start_time)).toEqual(['09:00', '10:00', '11:00', '12:00']);
});

test('a gap ending at an after-hours stop lists no hour past the day close', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  // Next anchor is an 18:30 stop, so latest_start_min (17:00) runs past the
  // 17:00 close; the last hour a one-hour visit can hold is 16:00.
  findAvailableSlots.mockResolvedValue({
    slots: [slot('2026-09-01', '15:00', 4, { latest_start_min: 17 * 60, day_close_min: 17 * 60 })], evaluated: 1,
  });
  loadOccupancy.mockResolvedValue(emptyOccupancy());
  const body = await (await post({ ...BASE, dateTo: '2026-09-01', summary: true, pickedDate: '2026-09-01', pickedStart: '17:00' })).json();
  expect(body.summary.days[0].hours.map((hour) => hour.start_time)).toEqual(['15:00', '16:00']);
  // Picking that 17:00 hour is refused before any gap is consulted.
  expect(body.picked).toEqual({ start: '17:00', fits: null, reason: 'not_checkable' });
});

test('a hint search spends no Google drive-time; the ranged button keeps it', async () => {
  await post({ ...BASE, summary: true });
  expect(findAvailableSlots.mock.calls[0][0].providerTravel).toBe(false);
  await post({ ...BASE, hint: undefined });
  expect(findAvailableSlots.mock.calls[1][0]).not.toHaveProperty('providerTravel');
});

test('summary days carry the calendar: closed days (blackout, Sunday) and the technician off', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
  const { absentTechDays } = require('../services/technician-eligibility');
  getBlackoutDates.mockResolvedValueOnce(new Set(['2026-09-03']));
  absentTechDays.mockResolvedValueOnce(new Set(['tech-1:2026-09-04']));
  findAvailableSlots.mockResolvedValue({ slots: [slot('2026-09-03', '09:00', 4)], evaluated: 1 });
  loadOccupancy.mockResolvedValue(emptyOccupancy());
  // Sep 1 2026 is a Tuesday; Sep 6 is the Sunday.
  const body = await (await post({ ...BASE, dateTo: '2026-09-06', technicianId: 'tech-1', summary: true })).json();
  const byDate = Object.fromEntries(body.summary.days.map((day) => [day.date, day]));
  expect(byDate['2026-09-03']).toMatchObject({ status: 'open', closed: true });
  expect(byDate['2026-09-03'].hours).toHaveLength(1);
  expect(byDate['2026-09-04']).toMatchObject({ status: 'off' });
  expect(byDate['2026-09-04'].closed).toBeUndefined();
  expect(byDate['2026-09-06']).toMatchObject({ closed: true });
  expect(byDate['2026-09-02']).toEqual({ date: '2026-09-02', status: 'full', hours: [] });
  expect(absentTechDays).toHaveBeenCalledWith(expect.anything(), { dateFrom: '2026-09-01', dateTo: '2026-09-06', technicianIds: ['tech-1'] });
  // An all-technician search has no one technician to be off.
  absentTechDays.mockClear();
  await post({ ...BASE, dateTo: '2026-09-06', summary: true });
  expect(absentTechDays).not.toHaveBeenCalled();
});

test('summary is a hint-mode construct: ignored without the hint flag', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  const body = await (await post({ ...BASE, hint: undefined, summary: true })).json();
  expect(body.summary).toBeUndefined();
});

test('the summary search is capped at 14 days however wide the request', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  const res = await post({ ...BASE, dateTo: '2026-11-30', summary: true });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(findAvailableSlots.mock.calls[0][0].dateTo).toBe('2026-09-14');
  expect(body.summary.days).toHaveLength(SUMMARY_MAX_DAYS);
  expect(body.range).toEqual({ dateFrom: '2026-09-01', dateTo: '2026-09-14' });
  // Without summary the ranged search keeps its own (90-day) ceiling.
  await post({ ...BASE, dateTo: '2026-11-30' });
  expect(findAvailableSlots.mock.calls[1][0].dateTo).toBe('2026-11-30');
});

test('a summary never searches before today: the engine, the range and every field start today', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  findAvailableSlots.mockResolvedValue({ slots: [slot('2026-09-01', '09:00', 3)], evaluated: 1 });
  const body = await (await post({ ...BASE, dateFrom: '2026-08-29', dateTo: '2026-09-01', summary: true })).json();
  // The gap engine walks whatever range it is given — past dates included —
  // so the clamp is on the search itself, not on the rows afterwards.
  expect(findAvailableSlots.mock.calls[0][0].dateFrom).toBe('2026-08-31');
  expect(body.range).toEqual({ dateFrom: '2026-08-31', dateTo: '2026-09-01' });
  expect(body.summary.days.map((day) => day.date)).toEqual(['2026-08-31', '2026-09-01']);
  // A picked date already gone is outside the search; a range wholly in the past has nothing to search.
  expect((await post({ ...BASE, dateFrom: '2026-08-29', dateTo: '2026-09-01', summary: true, pickedDate: '2026-08-30', pickedStart: '09:00' })).status).toBe(400);
  expect((await post({ ...BASE, dateFrom: '2026-08-20', dateTo: '2026-08-25', summary: true })).status).toBe(400);
  expect(findAvailableSlots).toHaveBeenCalledTimes(1);
  // The plain hint keeps the range it asked for.
  await post({ ...BASE, dateFrom: '2026-08-29', dateTo: '2026-09-01' });
  expect(findAvailableSlots.mock.calls[1][0].dateFrom).toBe('2026-08-29');
});

test('a summary is hourly whatever step the caller sends', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  findAvailableSlots.mockResolvedValue({
    slots: [slot('2026-09-01', '09:00', 4, { latest_start_min: 11 * 60 })], evaluated: 1,
  });
  for (const slotStepMinutes of [15, 30, undefined]) {
    const body = await (await post({ ...BASE, slotStepMinutes, dateTo: '2026-09-01', summary: true })).json();
    expect(findAvailableSlots.mock.lastCall[0].slotStepMinutes).toBe(60);
    expect(body.summary.days[0].hours.map((hour) => hour.start_time)).toEqual(['09:00', '10:00', '11:00']);
  }
  // Gate off: the caller's step is its own again.
  delete process.env.GATE_RESCHEDULE_AVAILABILITY;
  await post({ ...BASE, slotStepMinutes: 15, dateTo: '2026-09-01', summary: true });
  expect(findAvailableSlots.mock.lastCall[0].slotStepMinutes).toBe(15);
});

test('gap mode: the verdict is scored on pickedDate and names no_gap / occupied', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  const req = { ...BASE, summary: true, pickedDate: '2026-09-03' };
  // 09:00 on Sep 3 sits in a gap; on Sep 1 (dateFrom) it would too — the
  // technician proves which day was scored.
  let body = await (await post({ ...req, pickedStart: '11:00' })).json();
  expect(body.picked).toEqual(expect.objectContaining({ start: '11:00', fits: true, detour_minutes: 2 }));
  expect(body.picked.reason).toBeUndefined();
  // 14:00 is a gap on Sep 1 only.
  body = await (await post({ ...req, pickedStart: '14:00' })).json();
  expect(body.picked).toEqual({ start: '14:00', fits: false, reason: 'no_gap' });
  // An unassigned visit the engine cannot see occupies Sep 3 11:00.
  loadOccupancy.mockResolvedValue({
    ...emptyOccupancy(),
    rows: [{
      id: 'unassigned-1', date: '2026-09-03', startMin: 11 * 60, endMin: 12 * 60, customer_id: 'c1',
      technician_id: null, service_type: 'Pest Control', reservation_expires_at: null,
    }],
  });
  body = await (await post({ ...req, pickedStart: '11:00' })).json();
  expect(body.picked).toEqual({ start: '11:00', fits: false, reason: 'occupied' });
  expect(body.summary.days.find((day) => day.date === '2026-09-03').hours.map((hour) => hour.start_time)).toEqual(['09:00']);
});

test('an hour no verdict can cover answers fits:null with a reason, never a miss', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  const req = { ...BASE, summary: true, pickedDate: '2026-09-03' };
  for (const extra of [{ pickedStart: '09:15' }, { pickedStart: '10:00', pickedEnd: '09:00' }, { pickedStart: '05:00' }]) {
    const body = await (await post({ ...req, ...extra })).json();
    expect(body.picked).toEqual({ start: extra.pickedStart, fits: null, reason: 'not_checkable' });
  }
});

test('arrival mode: the route checker runs on pickedDate and its reason passes through', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
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
  findAvailableSlots.mockResolvedValue({ slots: [], evaluated: 0 });
  const req = {
    ...BASE, serviceId: 'fixture-service', technicianId: 't1', arrivalWindows: true,
    summary: true, pickedDate: '2026-09-03', pickedStart: '14:00',
  };
  for (const reason of ['arrival_window', 'return_time', 'day_overcommitted']) {
    checkArrivalPlacement.mockResolvedValue({ feasible: false, reason });
    const body = await (await post(req)).json();
    expect(body.picked).toEqual({ start: '14:00', fits: false, reason });
  }
  expect(checkArrivalPlacement).toHaveBeenLastCalledWith(expect.objectContaining({
    serviceId: 'fixture-service', date: '2026-09-03', technicianId: 't1', windowStart: '14:00', windowEnd: '15:00',
  }));
  checkArrivalPlacement.mockResolvedValue({ feasible: false, reason: 'route_unverified' });
  let body = await (await post(req)).json();
  expect(body.picked).toEqual({ start: '14:00', fits: null, reason: 'route_unverified' });
  checkArrivalPlacement.mockRejectedValue(new Error('route context unavailable'));
  body = await (await post(req)).json();
  expect(body.picked).toEqual({ start: '14:00', fits: null, reason: 'route_unverified' });
  // Unassigned: the checker would score the SAVED technician's route.
  checkArrivalPlacement.mockClear();
  body = await (await post({ ...req, technicianId: undefined })).json();
  expect(body.picked).toEqual({ start: '14:00', fits: null, reason: 'no_technician' });
  expect(checkArrivalPlacement).not.toHaveBeenCalled();
  checkArrivalPlacement.mockResolvedValue({ feasible: true, detourMinutes: 6 });
  body = await (await post(req)).json();
  expect(body.picked).toEqual(expect.objectContaining({ start: '14:00', fits: true, detour_minutes: 6 }));
  expect(body.picked.reason).toBeUndefined();
});

test('garbage summary / pickedDate 400 before the engine runs; pickedDate must be in range', async () => {
  process.env.GATE_RESCHEDULE_AVAILABILITY = 'true';
  // 2026-09-31 has the right shape and sorts inside a Sept–Oct range, but names no day.
  for (const extra of [
    { summary: 'yes' }, { summary: 1 }, { pickedDate: '09/03/2026' }, { pickedDate: 20260903 },
    { pickedDate: '2026-09-31', dateTo: '2026-10-05', summary: true }, { pickedDate: '2026-02-30' },
  ]) {
    expect((await post({ ...BASE, ...extra })).status).toBe(400);
  }
  for (const pickedDate of ['2026-08-31', '2026-09-06']) { // BASE searches Sep 1–5
    expect((await post({ ...BASE, summary: true, pickedDate, pickedStart: '09:00' })).status).toBe(400);
  }
  expect(findAvailableSlots).not.toHaveBeenCalled();
});

describe('summary helpers', () => {
  test('hintSearchPlan leaves every non-summary request exactly as asked', () => {
    const asked = { from: '2026-08-01', to: '2026-11-01', today: '2026-08-31', slotStepMinutes: 15, pickedDate: '2026-09-03' };
    for (const flags of [
      { hint: false, summary: true, summaryEnabled: true },
      { hint: true, summary: false, summaryEnabled: true },
      { hint: true, summary: true, summaryEnabled: false },
    ]) {
      expect(hintSearchPlan({ ...asked, ...flags })).toEqual({ summary: false, from: '2026-08-01', to: '2026-11-01', verdictDate: '2026-08-01', step: 15 });
    }
    expect(hintSearchPlan({ ...asked, hint: true, summary: true, summaryEnabled: true }))
      .toEqual({ summary: true, from: '2026-08-31', to: '2026-09-13', verdictDate: '2026-08-31', step: 60 });
    expect(hintSearchPlan({ ...asked, pickedStart: '09:00', hint: true, summary: true, summaryEnabled: true }).verdictDate).toBe('2026-09-03');
    expect(hintSearchPlan({ ...asked, slotStepMinutes: undefined, hint: true }).step).toBeUndefined();
  });

  test('the legacy 90-day ceiling caps a plain request but not a long-overdue summary', () => {
    const overdue = { from: '2026-05-01', to: '2026-09-10', maxTo: '2026-07-30', today: '2026-08-31' };
    expect(hintSearchPlan({ ...overdue, hint: true }).to).toBe('2026-07-30');
    expect(hintSearchPlan({ ...overdue, hint: true, summary: true, summaryEnabled: true }))
      .toEqual({ summary: true, from: '2026-08-31', to: '2026-09-10', verdictDate: '2026-08-31', step: 60 });
  });

  test('an omitted pickedDate defaults to dateFrom, so a past pick is out of range', () => {
    const past = { hint: true, summary: true, summaryEnabled: true, from: '2026-08-20', to: '2026-09-10', today: '2026-08-31' };
    expect(() => hintSearchPlan({ ...past, pickedStart: '09:00' })).toThrow('pickedDate must be inside the searched range');
    expect(hintSearchPlan({ ...past, pickedStart: '09:00', from: '2026-09-02' }).verdictDate).toBe('2026-09-02');
    expect(hintSearchPlan({ ...past, pickedStart: '09:00', pickedDate: '2026-09-03' }).verdictDate).toBe('2026-09-03');
  });

  test('summaryRangeEnd keeps a short range and caps a long one at 14 days', () => {
    expect(summaryRangeEnd('2026-09-01', '2026-09-01')).toBe('2026-09-01');
    expect(summaryRangeEnd('2026-09-01', '2026-09-11')).toBe('2026-09-11');
    expect(summaryRangeEnd('2026-09-01', '2026-12-01')).toBe('2026-09-14');
    // Month and DST boundaries (Nov 1 2026 is the fall-back day).
    expect(summaryRangeEnd('2026-10-25', '2026-12-01')).toBe('2026-11-07');
  });

  test('summarizeHintDays ignores slots outside the range and tolerates sparse slots', () => {
    const days = summarizeHintDays([
      { date: '2026-09-02', start_time: '10:00', end_time: '11:00' },
      { date: '2026-09-09', start_time: '10:00', end_time: '11:00', detour_minutes: 1 },
    ], { from: '2026-09-01', to: '2026-09-02' });
    expect(days).toEqual([
      { date: '2026-09-01', status: 'full', hours: [] },
      {
        date: '2026-09-02', status: 'open',
        hours: [{ start_time: '10:00', end_time: '11:00', detour_minutes: null, estimated_arrival: null, stops_that_day: null, technician: null }],
      },
    ]);
  });

  test('an empty day mixing unverified with a real refusal is full, not unverified', () => {
    const [day] = summarizeHintDays([], {
      from: '2026-09-01', to: '2026-09-01',
      rejectionsByDate: { '2026-09-01': { route_unverified: 3, arrival_window: 1 } },
    });
    expect(day.status).toBe('full');
  });
});
