// GATE_AUTO_DISPATCH_KEEP_TECH (owner 2026-10-25): the night run keeps each
// visit on its own technician. Gate reader + config, the slot filter in
// candidate-slots.js (`other_tech`), and the apply.js backstop
// (`TECH_CHANGE_BLOCKED`). No database.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue(),
  REMINDER_BLOCKING_STATUSES: new Set(['cancelled', 'canceled', 'completed', 'skipped', 'no_show', 'rescheduled']),
  reminderRowCanSend: (row) => !!row && row.cancelled !== true && row.suppressed_by_sibling !== true && row.windows_preclosed !== true,
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }),
  _private: { doneColumns: jest.fn(({ by, resolution, at }) => ({ done_at: at, done_by: by, resolution })) },
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn().mockResolvedValue({ failed: false, frozen: new Set() }),
  loadAnchorMap: jest.fn().mockResolvedValue(new Map()),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { autoDispatchKeepTechLive } = require('../config/feature-gates');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');
const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');
const { applyAutoDispatchMove } = require('../services/auto-dispatch/apply');
const { techChangeRefusal } = require('../services/auto-dispatch/keep-tech');

const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
const ORIGINAL_KEEP = process.env.GATE_AUTO_DISPATCH_KEEP_TECH;
beforeAll(() => { delete process.env.GATE_DRIVE_TIME_CALIBRATION; });
afterAll(() => {
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
  if (ORIGINAL_KEEP === undefined) delete process.env.GATE_AUTO_DISPATCH_KEEP_TECH;
  else process.env.GATE_AUTO_DISPATCH_KEEP_TECH = ORIGINAL_KEEP;
});

describe('gate reader and run config', () => {
  test('strict true, read at call time', () => {
    delete process.env.GATE_AUTO_DISPATCH_KEEP_TECH;
    expect(autoDispatchKeepTechLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) {
      process.env.GATE_AUTO_DISPATCH_KEEP_TECH = v;
      expect(autoDispatchKeepTechLive()).toBe(false);
    }
    process.env.GATE_AUTO_DISPATCH_KEEP_TECH = 'true';
    expect(autoDispatchKeepTechLive()).toBe(true);
  });

  test('config.keepTech follows the gate once per run; an override wins', () => {
    delete process.env.GATE_AUTO_DISPATCH_KEEP_TECH;
    expect(getAutoDispatchConfig().keepTech).toBe(false);
    process.env.GATE_AUTO_DISPATCH_KEEP_TECH = 'true';
    expect(getAutoDispatchConfig().keepTech).toBe(true);
    expect(getAutoDispatchConfig({ keepTech: false }).keepTech).toBe(false);
  });
});

function neighborDbStub() {
  return () => {
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => [];
    return c;
  };
}

const slot = (techId, date = '2026-08-05', start = '08:00') => ({
  date, technician: { id: techId, name: `Tech ${techId}` }, start_time: start, end_time: '09:00', detour_minutes: 5, total_drive_minutes: 20, stops_that_day: 3, score: 5,
});
const SERVICE = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1', window_start: '09:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
const PREFS = { blackout: null, service_category: 'general' };

function ctx(extra = {}) {
  return {
    db: neighborDbStub(),
    nowDate: new Date('2026-06-19T16:00:00Z'),
    lockWindowDays: 14,
    lookaheadDays: 90,
    topN: 60,
    capabilityFor: () => 'qualified',
    ...extra,
  };
}

describe('candidate slots', () => {
  beforeEach(() => jest.clearAllMocks());
  const SLOTS = [slot('t1'), slot('t2', '2026-08-05', '10:00'), slot('t2', '2026-08-06')];

  test('gate off: another technician\'s slots are still admitted, and the tally has no other_tech key', async () => {
    findAvailableSlots.mockResolvedValue({ slots: SLOTS });
    const { candidates, drops } = await findValidCandidateSlots(SERVICE, PREFS, ctx());
    expect(candidates.map((c) => c.technician_id).sort()).toEqual(['t1', 't2', 't2']);
    expect(drops).not.toHaveProperty('other_tech');
  });

  test('gate on: only the visit\'s own technician is offered, and other_tech counts the rest', async () => {
    findAvailableSlots.mockResolvedValue({ slots: SLOTS });
    const { candidates, drops, current } = await findValidCandidateSlots(SERVICE, PREFS, ctx({ keepTech: true }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ technician_id: 't1', date: '2026-08-05', start_time: '08:00' });
    expect(drops.other_tech).toBe(2);
    expect(current).toMatchObject({ is_current: true, technician_id: 't1' });
    // The search itself is unchanged: no new find-time option.
    expect(findAvailableSlots.mock.calls[0][0]).not.toHaveProperty('technicianId');
  });

  test('gate on: ids compare as strings, so a numeric id still matches', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [slot('7'), slot('8')] });
    const { candidates } = await findValidCandidateSlots({ ...SERVICE, technician_id: 7 }, PREFS, ctx({ keepTech: true }));
    expect(candidates.map((c) => c.technician_id)).toEqual(['7']);
  });

  test('gate on: an unassigned visit is not filtered', async () => {
    findAvailableSlots.mockResolvedValue({ slots: SLOTS });
    const { candidates, drops } = await findValidCandidateSlots({ ...SERVICE, technician_id: null }, PREFS, ctx({ keepTech: true }));
    expect(candidates.map((c) => c.technician_id).sort()).toEqual(['t1', 't2', 't2']);
    expect(drops.other_tech).toBe(0);
  });
});

describe('apply backstop', () => {
  const SVC = {
    id: 's1', status: 'confirmed', scheduled_date: '2026-08-04',
    window_start: '09:00', window_end: '11:00', technician_id: 't1', auto_dispatch_change_count: 0,
  };
  const TO_T2 = { date: '2026-08-11', start_time: '08:00', end_time: '10:00', technician_id: 't2' };
  const SAME = { ...TO_T2, technician_id: 't1' };
  const fresh = (tech = 't1') => ({
    where() { return this; },
    first: async () => ({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: tech, status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((s) => ({ raw: s }));
    db.fn = { now: jest.fn(() => 'now()') };
  });

  test('gate on: a technician change is refused before any write, with TECH_CHANGE_BLOCKED', async () => {
    db.mockImplementation(() => fresh());
    const err = await applyAutoDispatchMove(SVC, TO_T2, 'run1', { keepTech: true }).catch((e) => e);
    expect(err).toMatchObject({ code: 'TECH_CHANGE_BLOCKED', statusCode: 409 });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(techChangeRefusal(err)).toMatchObject({ reason_code: 'TECH_CHANGE_BLOCKED' });
  });

  test('gate on: a move that keeps the technician still applies', async () => {
    const queue = [fresh(), { where() { return this; }, update: jest.fn().mockResolvedValue(1) }];
    db.mockImplementation(() => queue.shift());
    const res = await applyAutoDispatchMove(SVC, SAME, 'run1', { keepTech: true });
    expect(res).toMatchObject({ ok: true, technician_changed: false });
    expect(SmartRebooker.reschedule.mock.calls[0][5].technicianId).toBeUndefined();
  });

  test('gate on: an unassigned visit may still be given a technician', async () => {
    const queue = [fresh(null), { where() { return this; }, update: jest.fn().mockResolvedValue(1) }];
    db.mockImplementation(() => queue.shift());
    const res = await applyAutoDispatchMove({ ...SVC, technician_id: null }, TO_T2, 'run1', { keepTech: true });
    expect(res).toMatchObject({ ok: true, technician_changed: true });
    expect(SmartRebooker.reschedule.mock.calls[0][5].technicianId).toBe('t2');
  });

  test('gate off: a technician change goes through as before', async () => {
    const queue = [fresh(), { where() { return this; }, update: jest.fn().mockResolvedValue(1) }];
    db.mockImplementation(() => queue.shift());
    const res = await applyAutoDispatchMove(SVC, TO_T2, 'run1', {});
    expect(res).toMatchObject({ ok: true, technician_changed: true });
    expect(SmartRebooker.reschedule.mock.calls[0][5].technicianId).toBe('t2');
  });

  test('the refusal helper ignores other errors and partly-moved groups', () => {
    expect(techChangeRefusal(Object.assign(new Error('x'), { code: 'SLOT_TAKEN' }))).toBeNull();
    expect(techChangeRefusal(Object.assign(new Error('x'), { code: 'TECH_CHANGE_BLOCKED', movedCount: 1 }))).toBeNull();
    expect(techChangeRefusal(null)).toBeNull();
  });
});
