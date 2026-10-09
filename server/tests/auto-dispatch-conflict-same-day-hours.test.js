// A visit that overlaps another customer's stop gets EVERY free whole-hour
// start on its own date as a candidate (replay 2026-10-09: the legacy slot
// finder, find-time.js candidatesForDay, offers one start per gap, so such a
// visit saw one to three candidates and took a far one). The added hours go
// through the same HARD filters and the writer's own conflict probe as every
// find-time slot, and are scored on the shared model.
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
  findAvailableSlots.mockResolvedValue({
    slots: [
      // The gap finder's one start for the gap after the other stop, plus a start on another day.
      { date: '2026-08-04', technician: { id: 't1', name: 'A' }, start_time: '11:00', end_time: '12:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1, score: 1 },
      { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 },
    ],
  });
});

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

test('a visit in overlap gets every free whole hour on its own date; the hours still taken are dropped by the writer\'s probe', async () => {
  const { candidates, current, drops } = await findValidCandidateSlots(SERVICE, PREFS, ctx());
  expect(current.conflict.kind).toBe('overlap');
  // 08:00 and 11:00-16:00 are free (end <= 17:00); 09:00 is the hour it holds, 10:00 is taken.
  expect(ownDayStarts(candidates)).toEqual(['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  expect(candidates.every((c) => c.model === 'shared_v1' && Number.isFinite(c.detour_minutes))).toBe(true);
  expect(candidates.find((c) => c.date === '2026-08-05')).toBeTruthy(); // other days untouched
  expect(drops.slot_taken).toBe(1); // 10:00 (the hour it holds is never offered at all)
});

test('a find-time slot is not duplicated; a longer visit stops at an end of 17:00', async () => {
  const { candidates } = await findValidCandidateSlots({ ...SERVICE, estimated_duration_minutes: 120 }, PREFS, ctx());
  const starts = ownDayStarts(candidates);
  expect(starts.filter((s) => s === '11:00')).toHaveLength(1);
  expect(starts[starts.length - 1]).toBe('15:00');
});

test('the same hard filters apply: explicit preferred time and a deactivated technician', async () => {
  const withWindow = { ...PREFS, preferred_time_window: { startMin: 12 * 60, endMin: 15 * 60 } };
  const timed = await findValidCandidateSlots(SERVICE, withWindow, ctx());
  expect(ownDayStarts(timed.candidates)).toEqual(['12:00', '13:00', '14:00']);
  const off = await findValidCandidateSlots(SERVICE, PREFS, ctx({ capabilityFor: () => 'deactivated' }));
  expect(off.candidates).toHaveLength(0);
});

test('nothing is added for a visit not in overlap, on a closed day, in capacity mode, or without the shared model', async () => {
  currentConflict.mockResolvedValue(null);
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);

  currentConflict.mockResolvedValue({ kind: 'closed_day', date: '2026-08-04' });
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);

  currentConflict.mockResolvedValue({ kind: 'overlap', date: '2026-08-04', with: ['other-1'] });
  process.env.GATE_SCHEDULING_CAPACITY = 'true'; // capacity mode already enumerates every whole hour
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);
  delete process.env.GATE_SCHEDULING_CAPACITY;

  delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; // added hours would carry no route numbers
  expect(ownDayStarts((await findValidCandidateSlots(SERVICE, PREFS, ctx())).candidates)).toEqual(['11:00']);
});
