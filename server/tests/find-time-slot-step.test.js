// find-time slotStepMinutes: auto-dispatch needs on-the-hour starts (stops are
// never at 10:15 / 1:30). Default (1) preserves exact earliest-feasible minute.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  // The stop query selects db.raw(...) coordinate expressions (stamped-address
  // divergence guard) — mirror knex's raw so building the select can't throw.
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The scheduler floors a same-day date at ET "now" + 30 min lead, so the
// fixture date below rotted the whole suite once the wall clock passed
// 08:00 ET on 2026-09-01 (main went red that morning). Pin ET "now" to a
// fixed instant the day BEFORE the fixture date; explicit dates still go
// through the real converter.
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z'); // 12:00 ET, Aug 31
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 0.5,
  // Keep the REAL miles->minutes model so this suite stays honest about the
  // estimator (and its gate) while still pinning geometry to 0.5 mi a leg.
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');

// These assertions assume LEGACY drive times (see the mocked haversine above),
// and the mock deliberately pulls the REAL gate-sensitive estimator. Pin the
// gate off so the suite does not depend on the ambient environment; the
// calibrated model is covered by drive-time-calibration.test.js.
const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
beforeAll(() => { delete process.env.GATE_DRIVE_TIME_CALIBRATION; });
afterAll(() => {
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
});


function chain(result) {
  const c = {};
  ['whereNotNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
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
const FUTURE_DATE_VALUE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000);
const NEXT_FUTURE_DATE_VALUE = nextBookableDate(FUTURE_DATE_VALUE);
const FUTURE_DATE = FUTURE_DATE_VALUE.toISOString().slice(0, 10);
const NEXT_FUTURE_DATE = NEXT_FUTURE_DATE_VALUE.toISOString().slice(0, 10);
const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 5 };

test('default (no step) returns the exact earliest-feasible minute', async () => {
  const { slots } = await findAvailableSlots(BASE);
  expect(slots.length).toBeGreaterThan(0);
  expect(slots[0].start_time).toBe('08:01'); // 08:00 open + 1 min drive from HQ
});

test('slotStepMinutes:60 snaps every start up to the hour', async () => {
  const { slots } = await findAvailableSlots({ ...BASE, slotStepMinutes: 60 });
  expect(slots.length).toBeGreaterThan(0);
  for (const s of slots) {
    expect(s.start_time.endsWith(':00')).toBe(true);
  }
  expect(slots[0].start_time).toBe('09:00'); // 08:01 rounded up to the next hour
});

test('earliestStartMin floors the gap start so a later preferred-time slot is generated', async () => {
  // Empty day: without the floor this gap collapses to ~08:01. An afternoon
  // preference (13:00) must still produce a candidate AT 13:00, not be lost.
  const { slots } = await findAvailableSlots({ ...BASE, earliestStartMin: 13 * 60 });
  expect(slots.length).toBeGreaterThan(0);
  expect(slots[0].start_time).toBe('13:00');
});

test('earliestStartMin past what fits before day close yields no slot (correctly)', async () => {
  // 16:30 floor + 60 min duration = 17:30 > 17:00 close → the gap can't fit it.
  const { slots } = await findAvailableSlots({ ...BASE, earliestStartMin: 16 * 60 + 30 });
  expect(slots.length).toBe(0);
});

test('emits latest_start_min — the last start whose end still clears the drive to the next anchor', async () => {
  const { slots } = await findAvailableSlots(BASE);
  // Empty day: HQ→HQ gap with 1-min mocked drives → latestEnd 16:59 (17:00
  // close minus the drive back), minus the 60-min duration.
  expect(slots[0].latest_start_min).toBe(16 * 60 + 59 - 60);
});

test('earliestStartMin default (0) is a no-op — identical legacy behavior', async () => {
  const { slots } = await findAvailableSlots(BASE);
  expect(slots[0].start_time).toBe('08:01');
});

test('a coordless stop (divergent stamped rental) degrades to zero drive, not hidden gaps (round-9 P2)', async () => {
  const stop = {
    id: 's1', scheduled_date: FUTURE_DATE, technician_id: 't1',
    window_start: '10:00', window_end: '11:00', service_type: 'pest',
    estimated_duration_minutes: 60,
    svc_lat: null, svc_lng: null, cust_lat: null, cust_lng: null,
    first_name: 'Rental', last_name: 'Stop', city: 'Venice',
  };
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([stop])));
  const { slots } = await findAvailableSlots(BASE);
  const starts = slots.map((s) => s.start_time);
  // Both gaps around the coordless stop must still offer slots.
  expect(starts.some((t) => t < '10:00')).toBe(true);
  expect(starts.some((t) => t >= '11:00')).toBe(true);
});

test('blackout dates are removed from the offer enumeration', async () => {
  // The only requested day is blacked out, so it yields zero candidates.
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'A' }]);
    if (table === 'schedule_blackout_dates') return chain([{ date: FUTURE_DATE }]);
    return chain([]);
  });
  const { slots } = await findAvailableSlots(BASE);
  expect(slots.length).toBe(0);
});

test('blackout removes only the blacked-out day from a range', async () => {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'A' }]);
    if (table === 'schedule_blackout_dates') return chain([{ date: FUTURE_DATE }]);
    return chain([]);
  });
  const { slots } = await findAvailableSlots({ ...BASE, dateTo: NEXT_FUTURE_DATE, topN: 50 });
  const dates = new Set(slots.map((s) => s.date));
  expect(dates.has(FUTURE_DATE)).toBe(false);
  expect(dates.has(NEXT_FUTURE_DATE)).toBe(true);
});

test('a failed blackout lookup fails OPEN — all dates still offered', async () => {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'A' }]);
    if (table === 'schedule_blackout_dates') {
      const c = chain([]);
      c.select = async () => { throw new Error('relation does not exist'); };
      return c;
    }
    return chain([]);
  });
  const { slots } = await findAvailableSlots(BASE);
  expect(slots.length).toBeGreaterThan(0);
});

describe('technician pool (Field Team Program, Phase 0)', () => {
  test('the tech query is narrowed to assignable rows (active employment AND field-dispatchable), never the legacy flag', async () => {
    const whereCalls = [];
    db.mockImplementation((table) => {
      const c = chain([]);
      if (table === 'technicians') {
        c.where = (...args) => { whereCalls.push(args); return c; };
        c.select = async () => [];
      }
      return c;
    });
    const out = await findAvailableSlots(BASE);
    expect(out).toMatchObject({ slots: [], evaluated: 0, note: 'No assignable technicians found' });
    expect(whereCalls).toEqual(expect.arrayContaining([
      ['technicians.employment_status', 'active'],
      ['technicians.field_dispatchable', true],
    ]));
    expect(whereCalls).not.toContainEqual([{ active: true }]);
  });

  test('a technicianId restriction is applied on top of the assignable filter, not instead of it', async () => {
    const whereCalls = [];
    db.mockImplementation((table) => {
      const c = chain([]);
      if (table === 'technicians') {
        c.where = (...args) => { whereCalls.push(args); return c; };
        c.select = async () => [];
      }
      return c;
    });
    await findAvailableSlots({ ...BASE, technicianId: 't-pinned' });
    expect(whereCalls).toEqual(expect.arrayContaining([
      ['technicians.employment_status', 'active'],
      ['technicians.field_dispatchable', true],
      ['technicians.id', 't-pinned'],
    ]));
  });
});
