/**
 * Customer reschedule page — the next plan visit's new date
 * (GATE_RESCHEDULE_NEXT_VISIT_DATE, owner 2026-10-09: show every plan shift
 * before the customer confirms).
 *
 * SmartRebooker.projectNextVisitDates names a date only when the move would
 * write it; routes/reschedule-public.js adds it to the GET payload only with
 * the gate on, for a series visit under collective anchoring.
 */
const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));
let mockNoWeekends = false;
jest.mock('../services/recurring-appointment-seeder', () => ({
  ...jest.requireActual('../services/recurring-appointment-seeder'),
  customerPrefersNoWeekends: jest.fn(async () => mockNoWeekends),
}));
let mockFreeze = { failed: false, frozen: new Set() };
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn(async () => mockFreeze),
}));

const SmartRebooker = require('../services/rebooker');
const router = require('../routes/reschedule-public');

const { loadNextVisitShift, nextVisitDateActive } = router._test;

// A quarterly plan: the parent is the visit being moved, with two later rows.
function plan(overrides = {}) {
  const parent = {
    id: 'svc-1', customer_id: 'cust-1', is_recurring: true, recurring_parent_id: null,
    recurring_pattern: 'quarterly', recurring_interval_days: null, recurring_nth: null, recurring_weekday: null,
    skip_weekends: false, scheduled_date: '2026-10-15', status: 'confirmed',
  };
  const rows = [
    { id: 'svc-1', status: 'confirmed', scheduled_date: '2026-10-15' },
    { id: 'svc-2', status: 'pending', scheduled_date: '2027-01-15' },
    { id: 'svc-3', status: 'pending', scheduled_date: '2027-04-15' },
  ].map((row) => ({
    customer_confirmed: false, date_exception: false, date_exception_cadence_date: null,
    auto_dispatch_locked: false, auto_dispatch_excluded: false, ...row,
  }));
  return { service: parent, parent, siblings: rows, ...overrides };
}

// A read-only connection: .first() answers the service, then the parent;
// .select() answers the sibling sweep.
function connFor({ service, parent, siblings }) {
  const firsts = [service, parent];
  return () => {
    const chain = {};
    for (const m of ['where', 'whereRaw', 'whereNotIn', 'orderByRaw']) chain[m] = () => chain;
    chain.first = async () => firsts.shift();
    chain.select = async () => siblings;
    return chain;
  };
}

beforeEach(() => {
  mockNoWeekends = false;
  mockFreeze = { failed: false, frozen: new Set() };
  delete process.env.GATE_RESCHEDULE_NEXT_VISIT_DATE;
  delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
});

describe('SmartRebooker.projectNextVisitDates', () => {
  test('names the next visit on its new cadence date for each offered date', async () => {
    const out = await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22', '2026-10-29'], { conn: connFor(plan()) });
    expect(out.currentDate).toBe('2027-01-15');
    // A quarterly plan keeps the picked day's place in its month: the 4th
    // Thursday of October gives the 4th Thursday of January, and a 5th
    // Thursday falls back to the last one. Not "the same number of days".
    expect(out.byDate).toEqual({ '2026-10-22': '2027-01-28', '2026-10-29': '2027-01-28' });
  });

  test('a same-date pick (time-only move) gets no entry', async () => {
    const out = await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-15', '2026-10-16'], { conn: connFor(plan()) });
    expect(Object.keys(out.byDate)).toEqual(['2026-10-16']);
  });

  test('null for a visit that is not on a plan', async () => {
    const p = plan();
    p.service = { ...p.service, is_recurring: false };
    expect(await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22'], { conn: connFor(p) })).toBeNull();
  });

  test('null when no later visit can move', async () => {
    const p = plan();
    p.siblings = [p.siblings[0]];
    expect(await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22'], { conn: connFor(p) })).toBeNull();
  });

  test.each([
    ['customer-confirmed', { customer_confirmed: true }],
    ['dispatch-locked', { auto_dispatch_locked: true }],
    ['dispatch-excluded', { auto_dispatch_excluded: true }],
  ])('null when the next visit is a kept commitment (%s)', async (_label, patch) => {
    const p = plan();
    p.siblings[1] = { ...p.siblings[1], ...patch };
    expect(await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22'], { conn: connFor(p) })).toBeNull();
  });

  test('null when the next visit already has a sendable reminder, or the reminder read fails', async () => {
    mockFreeze = { failed: false, frozen: new Set(['svc-2']) };
    expect(await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22'], { conn: connFor(plan()) })).toBeNull();
    mockFreeze = { failed: true, frozen: new Set() };
    expect(await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22'], { conn: connFor(plan()) })).toBeNull();
  });

  test('a skipped row before it keeps its cadence slot, so the next movable visit is one slot later', async () => {
    const p = plan();
    p.siblings[1] = { ...p.siblings[1], status: 'skipped' };
    const out = await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-22'], { conn: connFor(p) });
    expect(out.currentDate).toBe('2027-04-15');
    expect(out.byDate['2026-10-22']).toBe('2027-04-22');
  });

  test('a weekend-averse plan shifts the named date off the weekend, as the move does', async () => {
    mockNoWeekends = true;
    // 2026-10-24 is a Saturday; three months later, 2027-01-24, is a Sunday.
    const out = await SmartRebooker.projectNextVisitDates('svc-1', ['2026-10-24'], { conn: connFor(plan()) });
    expect(out.byDate['2026-10-24']).toBe('2027-01-25');
  });
});

describe('reschedule-public loadNextVisitShift', () => {
  const series = { id: 'svc-1', is_recurring: true, scheduled_date: '2026-10-15' };
  const availability = { days: [{ date: '2026-10-22' }, { date: '2026-10-29' }] };
  let spy;
  beforeEach(() => {
    spy = jest.spyOn(SmartRebooker, 'projectNextVisitDates')
      .mockResolvedValue({ currentDate: '2027-01-15', byDate: { '2026-10-22': '2027-01-22' } });
  });
  afterEach(() => spy.mockRestore());

  test('gate off: nothing is read and nothing is named', async () => {
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    expect(nextVisitDateActive()).toBe(false);
    expect(await loadNextVisitShift(series, availability)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('gate on, series visit, collective anchoring: the offered dates are projected', async () => {
    process.env.GATE_RESCHEDULE_NEXT_VISIT_DATE = 'true';
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    expect(await loadNextVisitShift(series, availability))
      .toEqual({ currentDate: '2027-01-15', byDate: { '2026-10-22': '2027-01-22' } });
    expect(spy).toHaveBeenCalledWith('svc-1', ['2026-10-22', '2026-10-29']);
  });

  test('gate on but no collective anchoring, a one-time visit, or no offered days: nothing is named', async () => {
    process.env.GATE_RESCHEDULE_NEXT_VISIT_DATE = 'true';
    expect(await loadNextVisitShift(series, availability)).toBeNull();
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    expect(await loadNextVisitShift({ ...series, is_recurring: false }, availability)).toBeNull();
    expect(await loadNextVisitShift(series, { days: [] })).toBeNull();
    expect(await loadNextVisitShift(series, null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('a projection failure or an empty projection leaves the payload without the key', async () => {
    process.env.GATE_RESCHEDULE_NEXT_VISIT_DATE = 'true';
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    spy.mockRejectedValueOnce(new Error('boom'));
    expect(await loadNextVisitShift(series, availability)).toBeNull();
    spy.mockResolvedValueOnce({ currentDate: '2027-01-15', byDate: {} });
    expect(await loadNextVisitShift(series, availability)).toBeNull();
    spy.mockResolvedValueOnce(null);
    expect(await loadNextVisitShift(series, availability)).toBeNull();
  });
});
