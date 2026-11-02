// GATE_AUTO_DISPATCH_MOWING_DAYS (owner 2026-11-02): Lawn Care Service visits
// stay off the customer's mowing day and one day on each side. The scope
// predicate, the blocked weekdays, the HARD slot filter (candidate-slots.js and
// the schedule gap tool), the 'mowing_day' conflict and its precedence, no
// needs-a-person notice for it, and the shadow audit block. No database.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  ...jest.requireActual('../services/route-optimizer'),
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  probeMoveConflicts: jest.fn(),
  occupancyProbeEnd: (start, end) => end || `${String(Number(String(start).slice(0, 2)) + 1).padStart(2, '0')}:00`,
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  techScopedConfirmActive: jest.fn(() => true),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({
  ...jest.requireActual('../services/scheduling/blackout-dates'),
  isBlackoutDate: jest.fn(async () => false),
}));

const db = require('../models/db');
const rebooker = require('../services/rebooker');
const blackout = require('../services/scheduling/blackout-dates');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { autoDispatchMowingDaysMode } = require('../config/feature-gates');
const mowingDays = require('../services/auto-dispatch/mowing-days');
const { normalizePreferences, getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');
const { currentConflict } = require('../services/auto-dispatch/current-conflict');
const { analyzeGapCandidate } = require('../services/scheduling/gap-candidates');
const { _internals: { evaluatePlacement, standingConflict } } = require('../services/auto-dispatch');

const GATE = 'GATE_AUTO_DISPATCH_MOWING_DAYS';
const SAVED = { mowing: process.env[GATE], drive: process.env.GATE_DRIVE_TIME_CALIBRATION, shared: process.env.GATE_AUTO_DISPATCH_SHARED_MODEL };
function restore(name, value) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
beforeAll(() => {
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
});
afterAll(() => {
  restore(GATE, SAVED.mowing);
  restore('GATE_DRIVE_TIME_CALIBRATION', SAVED.drive);
  restore('GATE_AUTO_DISPATCH_SHARED_MODEL', SAVED.shared);
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GATE];
  blackout.isBlackoutDate.mockResolvedValue(false);
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [] });
});

const LAWN = 'Monthly Lawn Care Service';
// 2026-08-04 is a Tuesday. Mowing on Monday blocks Sunday, Monday and Tuesday.
const TUE = '2026-08-04';
const WED = '2026-08-05';
const THU = '2026-08-06';

// A table-aware query stub: `tables[name]` gives what select / pluck / first resolve to.
function tableDb(tables = {}) {
  return jest.fn((name) => {
    const t = tables[name] || {};
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'forShare']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => t.rows || [];
    c.pluck = async () => t.pluck || [];
    c.first = async () => t.first;
    return c;
  });
}

const prefsFor = (mode, row = { mowing_days: ['Mon'] }, serviceType = LAWN) => mowingDays.withMowingRule(normalizePreferences(row, serviceType), row, mode);

describe('gate reader', () => {
  test('strict shadow | true, read at call time; anything else is off', () => {
    expect(autoDispatchMowingDaysMode()).toBe('off');
    for (const v of ['', '1', 'on', 'TRUE', 'Shadow', ' true']) {
      process.env[GATE] = v;
      expect(autoDispatchMowingDaysMode()).toBe('off');
    }
    process.env[GATE] = 'shadow';
    expect(autoDispatchMowingDaysMode()).toBe('shadow');
    expect(mowingDays.mowingDaysMode()).toBe('shadow');
    process.env[GATE] = 'true';
    expect(autoDispatchMowingDaysMode()).toBe('true');
  });
});

describe('scope and blocked weekdays', () => {
  test('Lawn Care Service plans are in; tree & shrub, aeration, dethatching, pest and palm are out', () => {
    for (const name of ['Every 6 Weeks Lawn Care Service', 'Monthly Lawn Care Service', 'Bi-Monthly Lawn Care Service', 'Quarterly Lawn Care Service']) {
      expect(mowingDays.isLawnCareService(name)).toBe(true);
    }
    for (const name of ['Tree & Shrub Care Service', 'Lawn Aeration', 'Lawn Plug Aeration', 'Lawn Dethatching', 'Quarterly Pest Control Service', 'Palm Injection', '', null]) {
      expect(mowingDays.isLawnCareService(name)).toBe(false);
    }
  });

  test('each mowing day and the day on each side, wrapping the week', () => {
    expect(mowingDays.blockedWeekdays(['Mon'])).toEqual([0, 1, 2]);
    expect(mowingDays.blockedWeekdays(['Sat'])).toEqual([0, 5, 6]);
    expect(mowingDays.blockedWeekdays(['Sun'])).toEqual([0, 1, 6]);
    expect(mowingDays.blockedWeekdays(['Mon', 'Thu'])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('the customer\'s preferred day is never blocked', () => {
    expect(mowingDays.blockedWeekdays(['Mon'], [2])).toEqual([0, 1]);
    const prefs = prefsFor('true', { preferred_day: 'tuesday', mowing_days: ['Mon'] });
    expect(prefs.preferred_day_indexes).toEqual([2]);
    expect(prefs.mowing.blocked_weekdays).toEqual([0, 1]);
  });

  test('a legacy JSON string reads like the array; empty or invalid blocks nothing', () => {
    expect(mowingDays.blockedWeekdays('["Wed"]')).toEqual([2, 3, 4]);
    for (const bad of [null, undefined, '', 'not json', '{"a":1}', [], ['Xyz'], 42]) {
      expect(mowingDays.blockedWeekdays(bad)).toEqual([]);
    }
  });

  test('gate off: the prefs object is returned untouched', () => {
    const base = normalizePreferences({ mowing_days: ['Mon'] }, LAWN);
    expect(mowingDays.withMowingRule(base, { mowing_days: ['Mon'] }, 'off')).toBe(base);
    expect(prefsFor('shadow').mowing).toEqual({ mode: 'shadow', days: ['Mon'], blocked_weekdays: [0, 1, 2] });
  });

  test('a unit is in scope when any member is a Lawn Care Service visit', () => {
    const prefs = prefsFor('true');
    expect(mowingDays.unitRule(prefs, [{ service_type: 'Quarterly Pest Control Service' }])).toBeNull();
    expect(mowingDays.unitRule(prefs, [{ service_type: 'Quarterly Pest Control Service' }, { service_type: LAWN }])).toBe(prefs.mowing);
    expect(mowingDays.unitRule(normalizePreferences(null, LAWN), [{ service_type: LAWN }])).toBeNull();
  });
});

describe('preferences read', () => {
  function prefsConn(row) {
    const first = jest.fn(async () => row);
    const conn = jest.fn(() => {
      const c = { where: () => c, forShare: () => c, first };
      return c;
    });
    return { conn, first };
  }

  test('gate off: mowing_days is not read and the prefs carry no rule', async () => {
    const { conn, first } = prefsConn({ preferred_day: null, mowing_days: ['Mon'] });
    const prefs = await getCustomerSchedulingPreferences('c1', LAWN, conn);
    expect(first.mock.calls[0]).not.toContain('mowing_days');
    expect(prefs).not.toHaveProperty('mowing');
  });

  test('shadow: the same row read gains mowing_days and the prefs carry the rule', async () => {
    process.env[GATE] = 'shadow';
    const { conn, first } = prefsConn({ preferred_day: null, mowing_days: ['Mon'] });
    const prefs = await getCustomerSchedulingPreferences('c1', LAWN, conn);
    expect(conn).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]).toContain('mowing_days');
    expect(prefs.mowing).toEqual({ mode: 'shadow', days: ['Mon'], blocked_weekdays: [0, 1, 2] });
  });
});

const slot = (date, start = '08:00', techId = 't1') => ({
  date, technician: { id: techId, name: `Tech ${techId}` }, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  detour_minutes: 5, total_drive_minutes: 20, stops_that_day: 3, score: 5,
});
const SERVICE = {
  id: 's1', customer_id: 'c1', scheduled_date: TUE, technician_id: 't1', window_start: '09:00', window_end: '10:00',
  estimated_duration_minutes: 60, lat: 27.4, lng: -82.5, service_type: LAWN,
};
const ctx = (extra = {}) => ({
  db: tableDb(),
  nowDate: new Date('2026-06-19T16:00:00Z'),
  lockWindowDays: 14,
  lookaheadDays: 90,
  topN: 60,
  capabilityFor: () => 'qualified',
  ...extra,
});

describe('HARD filter (candidate-slots.js)', () => {
  const SLOTS = [slot(TUE, '10:00'), slot(WED), slot(THU)];

  test('true: a slot on a blocked weekday is dropped and counted as mowing_day', async () => {
    findAvailableSlots.mockResolvedValue({ slots: SLOTS });
    const out = await findValidCandidateSlots(SERVICE, prefsFor('true'), ctx());
    expect(out.candidates.map((c) => c.date)).toEqual([WED, THU]);
    expect(out.drops.mowing_day).toBe(1);
    expect(out.mowing).toMatchObject({ mode: 'true', blocked_weekdays: [0, 1, 2] });
  });

  test('shadow and off keep every slot and the same drop tally (no mowing_day key)', async () => {
    findAvailableSlots.mockResolvedValue({ slots: SLOTS });
    const off = await findValidCandidateSlots(SERVICE, normalizePreferences({ mowing_days: ['Mon'] }, LAWN), ctx());
    const shadow = await findValidCandidateSlots(SERVICE, prefsFor('shadow'), ctx());
    expect(off.candidates.map((c) => c.date)).toEqual([TUE, WED, THU]);
    expect(shadow.candidates).toEqual(off.candidates);
    expect(shadow.drops).toEqual(off.drops);
    expect(off.drops).not.toHaveProperty('mowing_day');
    expect(off).not.toHaveProperty('mowing');
    expect(shadow.mowing.mode).toBe('shadow');
  });

  test('true: a pest visit is not filtered; the preferred-day filter still comes first', async () => {
    findAvailableSlots.mockResolvedValue({ slots: SLOTS });
    const pest = { ...SERVICE, service_type: 'Quarterly Pest Control Service' };
    const out = await findValidCandidateSlots(pest, prefsFor('true', { mowing_days: ['Mon'] }, pest.service_type), ctx());
    expect(out.candidates).toHaveLength(3);
    expect(out).not.toHaveProperty('mowing');
    // Preferred Wednesday: Tuesday and Thursday fail the preferred day before the mowing rule.
    const wed = await findValidCandidateSlots(SERVICE, prefsFor('true', { preferred_day: 'wednesday', mowing_days: ['Mon'] }), ctx());
    expect(wed.candidates.map((c) => c.date)).toEqual([WED]);
    expect(wed.drops).toMatchObject({ preferred_day: 2, mowing_day: 0 });
  });
});

describe('schedule gap tool (gap-candidates.js)', () => {
  const service = {
    id: 'candidate', technician_id: null, scheduled_date: '2040-09-11', status: 'pending',
    service_type: LAWN, estimated_duration_minutes: 60, lat: 27.39, lng: -82.39,
  };
  // 2040-09-10 is a Monday.
  const options = {
    date: '2040-09-10', today: '2040-09-09', now: new Date('2040-09-09T12:00:00Z'), technicianId: 'tech',
    departureMinutes: 480, targetReturnMinutes: 1020, breakMinutes: 30, closed: false,
  };
  const candidate = (preferences, svc = service) => ({ service: svc, preferences, holds: [], siblingDates: [], deactivated: [] });

  test('true refuses a blocked date as a customer date preference; shadow and pest work do not', () => {
    expect(analyzeGapCandidate(candidate(prefsFor('true')), [], options).reason).toBe('customer_date_preference');
    expect(analyzeGapCandidate(candidate(prefsFor('shadow')), [], options).reason).not.toBe('customer_date_preference');
    const pest = { ...service, service_type: 'Quarterly Pest Control Service' };
    expect(analyzeGapCandidate(candidate(prefsFor('true', { mowing_days: ['Mon'] }, pest.service_type), pest), [], options).reason)
      .not.toBe('customer_date_preference');
    expect(analyzeGapCandidate(candidate(prefsFor('true', { mowing_days: ['Thu'] })), [], options).reason).not.toBe('customer_date_preference');
  });
});

describe('mowing_day conflict (current-conflict.js)', () => {
  const CTX = (prefRow = { preferred_day: null, mowing_days: ['Mon'] }, extra = {}) => ({
    db: tableDb({ property_preferences: { first: prefRow }, ...extra }), conflictMoves: true,
  });

  test('true: a Lawn Care Service visit on a blocked weekday is in conflict', async () => {
    process.env[GATE] = 'true';
    expect(await currentConflict(SERVICE, CTX())).toEqual({ kind: 'mowing_day', date: TUE, mowing_days: ['Mon'] });
    expect(await currentConflict({ ...SERVICE, scheduled_date: WED }, CTX())).toBeNull();
    // The preferred day wins.
    expect(await currentConflict(SERVICE, CTX({ preferred_day: 'tuesday', mowing_days: ['Mon'] }))).toBeNull();
  });

  test('true: a pest visit is in conflict only when its unit holds a Lawn Care Service member', async () => {
    process.env[GATE] = 'true';
    const pest = { ...SERVICE, service_type: 'Quarterly Pest Control Service' };
    expect(await currentConflict(pest, CTX())).toBeNull();
    const grouped = CTX(undefined, { scheduled_services: { pluck: [LAWN] } });
    expect(await currentConflict(pest, grouped, new Set(['s1', 's1-lawn']))).toMatchObject({ kind: 'mowing_day' });
  });

  test('shadow and off: never a mowing_day conflict, and no preferences read', async () => {
    for (const mode of ['shadow', undefined]) {
      if (mode) process.env[GATE] = mode; else delete process.env[GATE];
      const c = CTX();
      expect(await currentConflict(SERVICE, c)).toBeNull();
      expect(c.db).not.toHaveBeenCalledWith('property_preferences');
    }
  });

  test('a closed day and an overlap come first', async () => {
    process.env[GATE] = 'true';
    blackout.isBlackoutDate.mockResolvedValue(true);
    expect(await currentConflict(SERVICE, CTX())).toEqual({ kind: 'closed_day', date: TUE });
    blackout.isBlackoutDate.mockResolvedValue(false);
    rebooker.probeMoveConflicts.mockResolvedValue({
      rows: [{ id: 'o1', customer_id: 'c2', technician_id: 't1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }],
    });
    expect(await currentConflict(SERVICE, CTX())).toEqual({ kind: 'overlap', date: TUE, with: ['o1'] });
  });
});

describe('no needs-a-person notice for a mowing_day conflict (index.js standingConflict)', () => {
  test('a visit whose only conflict is the mowing day reads clear; an overlap does not', async () => {
    process.env[GATE] = 'true';
    db.mockImplementation(tableDb({ scheduled_services: { first: { ...SERVICE, status: 'confirmed' } } }));
    const seen = { service: SERVICE, ctx: CTX_FOR_STANDING() };
    expect(await standingConflict(seen, 's1')).toEqual({ clear: true });
    rebooker.probeMoveConflicts.mockResolvedValue({
      rows: [{ id: 'o1', customer_id: 'c2', technician_id: 't1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }],
    });
    expect(await standingConflict(seen, 's1')).toMatchObject({ conflict: { kind: 'overlap', with: ['o1'] } });
  });
});

describe('no needs-a-person notice (needs-person-notice.js collectUnmoved)', () => {
  test('a mowing_day conflict is never collected, even when a failed re-read keeps what the run saw', () => {
    const notice = require('../services/auto-dispatch/needs-person-notice');
    const bucket = new Map();
    notice.collectUnmoved(bucket, { id: 'v1', scheduled_date: TUE }, 'NO_VALID_SLOT', { kind: 'mowing_day', date: TUE });
    expect(bucket.size).toBe(0);
    notice.collectUnmoved(bucket, { id: 'v2', scheduled_date: TUE }, 'NO_VALID_SLOT', { kind: 'overlap', date: TUE, with: ['o1'] });
    notice.collectUnmoved(bucket, { id: 'v3', scheduled_date: TUE }, 'NO_VALID_SLOT', { kind: 'closed_day', date: TUE });
    expect([...bucket.values()].map((i) => i.problem)).toEqual(['overlap', 'closed_day']);
  });
});

function CTX_FOR_STANDING() {
  return { db: tableDb({ property_preferences: { first: { preferred_day: null, mowing_days: ['Mon'] } } }), conflictMoves: true };
}

describe('evaluation and audit (index.js evaluatePlacement)', () => {
  const CONFIG = { minScoreImprovement: 15, removeStabilityFloor: 35, minDayMoveDriveSavingMinutes: 6 };
  const evalCtx = () => ctx({ conflictMoves: true, db: tableDb({ property_preferences: { first: { preferred_day: null, mowing_days: ['Mon'] } } }) });
  const without = (result) => {
    const copy = JSON.parse(JSON.stringify(result));
    delete copy.audit.constraints.mowing_days;
    return copy;
  };

  test('shadow: the decision is the one off makes; the audit row logs the rule and what true would do', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [slot(TUE, '10:00'), slot(WED)] });
    const off = await evaluatePlacement(SERVICE, normalizePreferences({ mowing_days: ['Mon'] }, LAWN), evalCtx(), CONFIG, '2026-07-03');
    process.env[GATE] = 'shadow';
    const shadow = await evaluatePlacement(SERVICE, prefsFor('shadow'), evalCtx(), CONFIG, '2026-07-03');
    expect(off.audit.constraints).not.toHaveProperty('mowing_days');
    expect(without(shadow)).toEqual(JSON.parse(JSON.stringify(off)));
    expect(shadow.kind).toBe('no_change');
    expect(shadow.audit.constraints.mowing_days).toEqual({
      mode: 'shadow',
      mowing_days: ['Mon'],
      blocked_weekdays: [0, 1, 2],
      current_blocked: true,
      chosen_blocked: true,
      shadow_best: { date: WED, start: '08:00' },
      would_move: true,
    });
  });

  test('true: the visit is in conflict and moves to the open day without the score bar', async () => {
    process.env[GATE] = 'true';
    findAvailableSlots.mockResolvedValue({ slots: [slot(TUE, '10:00'), slot(WED)] });
    const result = await evaluatePlacement(SERVICE, prefsFor('true'), evalCtx(), CONFIG, '2026-07-03');
    expect(result.kind).toBe('move');
    // The Tuesday slot never became a candidate (the move row carries no drop tally).
    expect(result.rankedCandidates.map((c) => c.date)).toEqual([WED]);
    expect(result.best).toMatchObject({ date: WED, start_time: '08:00' });
    expect(result.current.conflict).toEqual({ kind: 'mowing_day', date: TUE, mowing_days: ['Mon'] });
    expect(result.audit.constraints.conflict).toMatchObject({ kind: 'mowing_day' });
    expect(result.audit.constraints.mowing_days).toMatchObject({ mode: 'true', current_blocked: true, chosen_blocked: false });
    expect(result.audit.constraints.mowing_days).not.toHaveProperty('shadow_best');
  });

  test('true: no open day -> the visit stays, and the row says why', async () => {
    process.env[GATE] = 'true';
    findAvailableSlots.mockResolvedValue({ slots: [slot(TUE, '10:00')] });
    const result = await evaluatePlacement(SERVICE, prefsFor('true'), evalCtx(), CONFIG, '2026-07-03');
    expect(result.kind).toBe('no_change');
    expect(result.conflict).toMatchObject({ kind: 'mowing_day' });
    expect(result.audit.constraints).toMatchObject({ drops: { mowing_day: 1 }, conflict: { kind: 'mowing_day' }, mowing_days: { current_blocked: true } });
  });
});
