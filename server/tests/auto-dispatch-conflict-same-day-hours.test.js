// A visit that overlaps another customer's stop gets EVERY free whole-hour
// start on its own date as a candidate (replay 2026-10-09: the legacy slot
// finder, find-time.js candidatesForDay, offers one start per gap, so such a
// visit saw one to three candidates and took a far one). The added hours come
// from the SAME finder (everyStepStart, one technician, one date), so each has
// passed its drive-in / drive-out bounds, time off and closed days (Codex
// #6253 r1 P1: hours built by hand skipped those). They then go through the
// same HARD filters and the writer's own conflict probe as every other slot.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));
jest.mock('../services/visit-groups', () => ({
  openMembers: jest.fn(),
  predictMemberWindows: jest.requireActual('../services/visit-groups').predictMemberWindows,
}));
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn().mockResolvedValue({ rows: [], snapshot: [] }),
  occupancyProbeEnd: jest.requireActual('../services/rebooker').occupancyProbeEnd,
}));
jest.mock('../services/auto-dispatch/current-conflict', () => ({ currentConflict: jest.fn() }));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { probeMoveConflicts } = require('../services/rebooker');
const { currentConflict } = require('../services/auto-dispatch/current-conflict');
const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');

const ENV = ['GATE_AUTO_DISPATCH_SHARED_MODEL', 'GATE_SCHEDULING_CAPACITY', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => ENV.forEach((k) => { saved[k] = process.env[k]; }));
afterAll(() => ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  delete process.env.GATE_SCHEDULING_CAPACITY;
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  // Another customer's stop 09:30-10:30 on every probed date: the hours 09:00 and 10:00 are taken.
  probeMoveConflicts.mockImplementation(async () => ({
    rows: [{ id: 'other-1', window_start: '09:30', window_end: '10:30', estimated_duration_minutes: 60 }], snapshot: [],
  }));
  currentConflict.mockResolvedValue({ kind: 'overlap', date: '2026-08-04', with: ['other-1'] });
  sameDayStarts = ['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
  findAvailableSlots.mockImplementation(async (opts) => (opts.everyStepStart
    // The finder's own answer for the one technician and date: the starts its gap bounds admit.
    ? { slots: sameDayStarts.map((start) => slot('2026-08-04', start)) }
    : {
      slots: [
        // The gap finder's one start for the gap after the other stop, plus a start on another day.
        slot('2026-08-04', '11:00'),
        { ...slot('2026-08-05', '08:00'), detour_minutes: 2, total_drive_minutes: 12, score: 2 },
      ],
    }));
});

let sameDayStarts;
const endOf = (start) => `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`;
const slot = (date, start) => ({
  date, technician: { id: 't1', name: 'A' }, start_time: start, end_time: endOf(start), detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1, score: 1,
});
const sameDayCalls = () => findAvailableSlots.mock.calls.map(([opts]) => opts).filter((opts) => opts.everyStepStart);

const SERVICE = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1', window_start: '09:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
const PREFS = { service_category: 'general', blackout: null };

function emptyDb() {
  const c = {};
  ['where', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
    .forEach((m) => { c[m] = () => c; });
  c.select = async () => [];
  return () => c;
}

const ctx = (over = {}) => ({
  db: emptyDb(), nowDate: new Date('2026-06-19T16:00:00Z'), lockWindowDays: 14, lookaheadDays: 90, topN: 60, conflictMoves: true, capabilityFor: () => 'qualified', ...over,
});
const ownDayStarts = (candidates) => candidates.filter((c) => c.date === '2026-08-04').map((c) => c.start_time).sort();

test('a visit in overlap gets the finder\'s every-hour starts on its own date, for its own technician', async () => {
  const { candidates, current } = await findValidCandidateSlots(SERVICE, PREFS, ctx());
  expect(current.conflict.kind).toBe('overlap');
  expect(ownDayStarts(candidates)).toEqual(['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  expect(candidates.every((c) => c.model === 'shared_v1' && Number.isFinite(c.detour_minutes))).toBe(true);
  expect(candidates.find((c) => c.date === '2026-08-05')).toBeTruthy(); // other days untouched
  // One extra search: the visit's date only, its technician only, the same exclusions and step.
  expect(sameDayCalls()).toHaveLength(1);
  expect(sameDayCalls()[0]).toMatchObject({
    dateFrom: '2026-08-04', dateTo: '2026-08-04', technicianId: 't1', everyStepStart: true, slotStepMinutes: 60, strictBlackout: true, excludeServiceIds: ['s1'],
  });
});

// Codex #6253 r1 P1: an hour the finder does not return (no drive time from the
// stop before it, the technician is out that day) is never a candidate.
test('an hour the finder does not admit is never added', async () => {
  sameDayStarts = ['13:00'];
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00', '13:00']);
  sameDayStarts = []; // the technician is out, or no hour fits
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);
});

test('a start the first search returned is not duplicated; the hour the visit holds and another technician\'s slot are not added', async () => {
  sameDayStarts = ['09:00', '11:00', '12:00'];
  const other = { ...slot('2026-08-04', '14:00'), technician: { id: 't2', name: 'B' } };
  findAvailableSlots.mockImplementation(async (opts) => (opts.everyStepStart
    ? { slots: [...sameDayStarts.map((start) => slot('2026-08-04', start)), other] }
    : { slots: [slot('2026-08-04', '11:00')] }));
  const { candidates } = await findValidCandidateSlots(SERVICE, PREFS, ctx());
  expect(ownDayStarts(candidates)).toEqual(['11:00', '12:00']);
});

test('the same hard filters apply: explicit preferred time and a deactivated technician', async () => {
  const withWindow = { ...PREFS, preferred_time_window: { startMin: 12 * 60, endMin: 15 * 60 } };
  const timed = await findValidCandidateSlots(SERVICE, withWindow, ctx());
  expect(ownDayStarts(timed.candidates)).toEqual(['12:00', '13:00', '14:00']);
  const off = await findValidCandidateSlots(SERVICE, PREFS, ctx({ capabilityFor: () => 'deactivated' }));
  expect(off.candidates).toHaveLength(0);
});

test('no extra search for a visit not in overlap, on a closed day, in capacity mode, or without the shared model', async () => {
  currentConflict.mockResolvedValue(null);
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);

  currentConflict.mockResolvedValue({ kind: 'closed_day', date: '2026-08-04' });
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);

  currentConflict.mockResolvedValue({ kind: 'overlap', date: '2026-08-04', with: ['other-1'] });
  process.env.GATE_SCHEDULING_CAPACITY = 'true'; // capacity mode already enumerates every whole hour
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);
  delete process.env.GATE_SCHEDULING_CAPACITY;

  delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; // the only mode this was measured in
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);
  expect(sameDayCalls()).toHaveLength(0);
});

// find-time.js: the option itself. One gap from 08:20 to a latest start of 13:10.
describe('find-time everyStepStart (legacy path)', () => {
  const { legacyGapStarts } = jest.requireActual('../services/scheduling/find-time')._internals;
  const gap = { earliestFloor: 8 * 60 + 20, latestStartFloor: 13 * 60 + 10 };
  const base = { slotStepMinutes: 60, durationMinutes: 60, dayClose: 17 * 60 };

  test('default: one start, the earliest snapped to the step (unchanged)', () => {
    expect(legacyGapStarts(gap, base)).toEqual([9 * 60]);
    expect(legacyGapStarts(gap, { ...base, slotStepMinutes: 1 })).toEqual([8 * 60 + 20]);
  });

  test('on: every step start inside the SAME gap bounds, and none past the day\'s close', () => {
    expect(legacyGapStarts(gap, { ...base, everyStepStart: true })).toEqual([9, 10, 11, 12, 13].map((h) => h * 60));
    // A wide-open gap stops at an end of 17:00.
    const open = { earliestFloor: 8 * 60, latestStartFloor: 17 * 60 };
    expect(legacyGapStarts(open, { ...base, durationMinutes: 120, everyStepStart: true }).pop()).toBe(15 * 60);
    // A gap the first start does not fit offers nothing, on or off.
    expect(legacyGapStarts({ earliestFloor: 600, latestStartFloor: 590 }, { ...base, everyStepStart: true })).toEqual([]);
    // No step, no extra starts.
    expect(legacyGapStarts(gap, { ...base, slotStepMinutes: 1, everyStepStart: true })).toEqual([8 * 60 + 20]);
  });
});
