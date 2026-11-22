// FLEX-TIER destination freeze through the REAL slot generator (Codex #4995
// pre-push P1). find-time's gap path emits only each gap's earliest feasible
// start, so on the date the 73h freeze ends an open gap would yield a frozen
// morning start — dropped by the per-slot filter — and never the legal later
// start in the same gap. The flexible tier floors that date's generation just
// past the boundary (find-time startFloorByDate), so the later start exists.
// Harness mirrors find-time-slot-step.test.js: real find-time + candidate-
// slots over a mocked db, empty route, 0.5-mile legs.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z'); // find-time's "today" (12:00 ET, Aug 31)
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 0.5,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');
const { parseETDateTime } = require('../utils/datetime-et');


function chain(result) {
  const c = {};
  ['whereNotNull', 'whereNull', 'where', 'whereNot', 'whereBetween', 'whereIn', 'whereNotIn', 'orWhere', 'leftJoin', 'orderBy', 'first']
    .forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

beforeEach(() => {
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([])));
});

function nextBookableDate(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0);
  return date;
}
const DATE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

test('flex tier: an open gap on the freeze-boundary date yields its first legal start, not a frozen earlier one', async () => {
  // The freeze ends at 10:30 ET on DATE. Unfloored, the empty day's single
  // gap snaps to 09:00 — inside the freeze — and the day would offer nothing.
  const nowDate = new Date(parseETDateTime(`${DATE}T10:30`).getTime() - 73 * 3600000);
  const service = {
    id: 's1', customer_id: 'c1', scheduled_date: DATE, technician_id: 't1', window_start: '15:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5,
  };
  const prefs = { blackout: null, service_category: 'general' };
  const ctx = {
    db: () => chain([]),
    nowDate,
    lockWindowDays: 14,
    lookaheadDays: 90,
    topN: 60,
    capabilityFor: () => 'qualified',
    tierWindow: { dateFrom: DATE, dateTo: DATE },
  };

  const flex = await findValidCandidateSlots(service, prefs, { ...ctx, tierMeta: { mode: 'flex' } });
  expect(flex.candidates.map((c) => c.start_time)).toEqual(['11:00']);
  expect(flex.drops.flex_frozen).toBe(0);

  // Route tiers (no freeze floor): the same gap collapses to 09:00.
  const tiers = await findValidCandidateSlots(service, prefs, { ...ctx, tierMeta: { mode: 'tiers' } });
  expect(tiers.candidates.map((c) => c.start_time)).toEqual(['09:00']);
});

test('flex tier: a destination 7 days out is admitted for a +/-7 visit and dropped as flex_floor for a +/-5 visit', () => {
  const { flexCandidateRules, flexTierMoveWindow } = require('../services/auto-dispatch/flex-tier');
  const { shiftDateStr } = require('../services/auto-dispatch/dates');
  const service = { id: 's1', scheduled_date: DATE, window_start: '09:00' };
  const nowDate = new Date('2026-08-31T16:00:00Z');
  const slots = [{ date: shiftDateStr(DATE, 7), start_time: '09:00' }, { date: shiftDateStr(DATE, 5), start_time: '09:00' }];
  const admitted = (radiusDays) => {
    const tierWindow = flexTierMoveWindow({
      origDate: DATE, anchorDate: DATE, today: '2026-08-31', neighbors: {}, radiusDays,
    });
    const drops = { flex_frozen: 0, flex_floor: 0 };
    const kept = flexCandidateRules(service, { tierMeta: { mode: 'flex' }, nightLock24h: true, nowDate, tierWindow }).admit(slots, drops);
    return { dates: kept.map((s) => s.date), drops };
  };
  expect(admitted(7)).toEqual({ dates: [shiftDateStr(DATE, 7), shiftDateStr(DATE, 5)], drops: { flex_frozen: 0, flex_floor: 0 } });
  expect(admitted(5)).toEqual({ dates: [shiftDateStr(DATE, 5)], drops: { flex_frozen: 0, flex_floor: 1 } });
  expect(admitted(undefined).dates).toEqual([shiftDateStr(DATE, 5)]);
});
