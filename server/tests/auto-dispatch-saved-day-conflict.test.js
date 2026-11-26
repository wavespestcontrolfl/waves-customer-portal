// The saved-day conflict (owner 2026-11-25 "fix auto dispatch"): a visit that is not on the weekday the customer
// saved in the app is in conflict, so auto-dispatch moves it back to that day even when no drive time is saved.
// It comes after a closed day, an overlap and a mowing day, raises no needs-a-person notice, and the move is fenced
// on the customer's preference row. No database.
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
const { currentConflict } = require('../services/auto-dispatch/current-conflict');
const { _internals: { standingConflict } } = require('../services/auto-dispatch');

beforeEach(() => {
  jest.clearAllMocks();
  blackout.isBlackoutDate.mockResolvedValue(false);
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [] });
});

// 2026-08-03 is a Monday, 2026-08-05 a Wednesday.
const MON = '2026-08-03';
const WED = '2026-08-05';
const PEST = 'Quarterly Pest Control Service';
const LAWN = 'Monthly Lawn Care Service';

function tableDb(tables = {}) {
  return jest.fn((name) => {
    const t = tables[name] || {};
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'orWhere', 'leftJoin', 'orderBy', 'forShare'].forEach((m) => { c[m] = () => c; });
    c.select = async () => t.rows || [];
    c.pluck = async () => t.pluck || [];
    c.first = async () => t.first;
    return c;
  });
}

const SERVICE = {
  id: 's1', customer_id: 'c1', scheduled_date: MON, technician_id: 't1', window_start: '09:00', window_end: '10:00',
  estimated_duration_minutes: 60, service_type: PEST,
};
const CTX = (prefRow, extra = {}) => ({ db: tableDb({ property_preferences: { first: prefRow }, ...extra }), conflictMoves: true });

describe('preferred_day conflict (current-conflict.js)', () => {
  test('a visit off the saved weekday is in conflict; on it, none', async () => {
    expect(await currentConflict(SERVICE, CTX({ preferred_day: 'wednesday', mowing_days: null })))
      .toEqual({ kind: 'preferred_day', date: MON, preferred_days: [3] });
    expect(await currentConflict({ ...SERVICE, scheduled_date: WED }, CTX({ preferred_day: 'wednesday', mowing_days: null }))).toBeNull();
  });

  test('no saved day, no preference row, or "no preference": no conflict', async () => {
    expect(await currentConflict(SERVICE, CTX({ preferred_day: 'no_preference', mowing_days: null }))).toBeNull();
    expect(await currentConflict(SERVICE, CTX({ preferred_day: null, mowing_days: null }))).toBeNull();
    expect(await currentConflict(SERVICE, CTX(undefined))).toBeNull();
  });

  test('a visit with no arrival time and a run with conflict moves off are never in conflict', async () => {
    expect(await currentConflict({ ...SERVICE, window_start: null }, CTX({ preferred_day: 'wednesday' }))).toBeNull();
    expect(await currentConflict(SERVICE, { ...CTX({ preferred_day: 'wednesday' }), conflictMoves: false })).toBeNull();
  });

  test('a closed day, an overlap and a mowing day come first', async () => {
    const pref = { preferred_day: 'wednesday', mowing_days: ['Sun'] };
    blackout.isBlackoutDate.mockResolvedValue(true);
    expect(await currentConflict(SERVICE, CTX(pref))).toEqual({ kind: 'closed_day', date: MON });
    blackout.isBlackoutDate.mockResolvedValue(false);
    expect(await currentConflict({ ...SERVICE, service_type: LAWN }, CTX(pref))).toMatchObject({ kind: 'mowing_day' });
    rebooker.probeMoveConflicts.mockResolvedValue({
      rows: [{ id: 'o1', customer_id: 'c2', technician_id: 't1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }],
    });
    expect(await currentConflict(SERVICE, CTX(pref))).toEqual({ kind: 'overlap', date: MON, with: ['o1'] });
  });
});

describe('no needs-a-person notice for a preferred_day conflict', () => {
  test('standingConflict reads clear for a visit whose only conflict is the saved day', async () => {
    db.mockImplementation(tableDb({ scheduled_services: { first: { ...SERVICE, status: 'confirmed' } } }));
    const seen = { service: SERVICE, ctx: CTX({ preferred_day: 'wednesday', mowing_days: null }) };
    expect(await standingConflict(seen, 's1')).toEqual({ clear: true });
  });

  test('collectUnmoved never collects it', () => {
    const notice = require('../services/auto-dispatch/needs-person-notice');
    const bucket = new Map();
    notice.collectUnmoved(bucket, { id: 'v1', scheduled_date: MON }, 'NO_VALID_SLOT', { kind: 'preferred_day', date: MON, preferred_days: [3] });
    expect(bucket.size).toBe(0);
  });
});

// Customer blackout (owner 2026-11-26 "move away", replay audit): a visit inside the do-not-come dates the office set
// on the customer's profile is in conflict after a closed day, and a person hears about it when it cannot move.
describe('customer_blackout conflict (current-conflict.js)', () => {
  const OFF = { blackout_start: '2026-08-01', blackout_end: '2026-08-04', preferred_day: 'wednesday', mowing_days: null };
  test('inside the blackout dates: in conflict, ahead of an overlap and the saved day; outside or none: no blackout conflict', async () => {
    rebooker.probeMoveConflicts.mockResolvedValue({
      rows: [{ id: 'o1', customer_id: 'c2', technician_id: 't1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }],
    });
    expect(await currentConflict(SERVICE, CTX(OFF))).toEqual({ kind: 'customer_blackout', date: MON, start: '2026-08-01', end: '2026-08-04' });
    rebooker.probeMoveConflicts.mockResolvedValue({ rows: [] });
    expect(await currentConflict({ ...SERVICE, scheduled_date: WED }, CTX(OFF))).toBeNull();
    expect(await currentConflict(SERVICE, CTX({ ...OFF, blackout_end: null }))).toMatchObject({ kind: 'preferred_day' });
  });

  test('a closed day comes first', async () => {
    blackout.isBlackoutDate.mockResolvedValue(true);
    expect(await currentConflict(SERVICE, CTX(OFF))).toEqual({ kind: 'closed_day', date: MON });
  });

  test('not silent: standingConflict keeps it and collectUnmoved raises the blackout wording', async () => {
    db.mockImplementation(tableDb({ scheduled_services: { first: { ...SERVICE, status: 'confirmed' } } }));
    const seen = { service: SERVICE, ctx: CTX(OFF) };
    expect(await standingConflict(seen, 's1')).toMatchObject({ conflict: { kind: 'customer_blackout' } });
    const notice = require('../services/auto-dispatch/needs-person-notice');
    const bucket = new Map();
    notice.collectUnmoved(bucket, { id: 'v1', scheduled_date: MON }, 'NO_VALID_SLOT', { kind: 'customer_blackout', date: MON });
    expect([...bucket.values()][0]).toMatchObject({ problem: 'customer_blackout', kind: 'no_slot' });
  });
});
