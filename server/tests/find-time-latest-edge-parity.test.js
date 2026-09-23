/**
 * find-time packEnds (owner bug report 2026-09-23): on a day with real
 * stops, customer-facing callers get BOTH the earliest-after-prev and
 * latest-before-next packed candidates per gap (one when they coincide),
 * restricted to the end(s) that actually border a stop — instead of the
 * single earliest-feasible-minute candidate that let a leading gap always
 * promote a hole-making 9 AM. Legacy (packEnds omitted) and empty-day
 * output stay byte-identical.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z');
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
// Zero-mile legs -> zero modeled drive minutes, so every candidate boundary
// is pure buffer/padding arithmetic (matches the picker-sim harness, whose
// scenarios put the customer and the neighbouring stop in the same city).
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 3,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { customerFacingBufferMinutes } = require('../services/scheduling/travel-gap');
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  clearExpectedServiceMinutesCache();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function chain(result) {
  const c = {};
  ['whereNotNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

function nextBookableDate(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0);
  return date;
}
const FUTURE_DATE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const BASE = { lat: 27.4, lng: -82.4, durationMinutes: 60, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 200 };

const STOP_COORDS = { svc_lat: 27.4, svc_lng: -82.4, cust_lat: null, cust_lng: null };
function stopRow(id, start, end) {
  return {
    id, scheduled_date: FUTURE_DATE, technician_id: 't1',
    window_start: start, window_end: end, service_type: 'pest_control', service_key_snapshot: null,
    estimated_duration_minutes: null, ...STOP_COORDS,
    first_name: 'Existing', last_name: 'Stop', city: 'Lakewood Ranch',
  };
}

// No catalog row matches 'pest_control' (bare service_type, no key) — every
// stop and the candidate itself fall back to their own window length, i.e.
// zero padding, the plain drive(0)+buffer(15) gap.
const NO_CATALOG_ROWS = [];
// A quarterly-pest catalog row (min 30 / max 60 -> expected 45) keyed by
// name, matched via services.name = scheduled_services.service_type/opts.serviceType.
const QUARTERLY_PEST_CATALOG = [{
  service_key: 'quarterly_pest', name: 'pest_control',
  min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null,
}];

function wireDb({ stops, catalog }) {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Adam' }]);
    if (table === 'services') return chain(catalog);
    return chain(stops); // scheduled_services
  });
}


/**
 * Offer/commit parity on the LATEST edge (push-audit P1): with a real drive
 * to the next stop, find-time's latest start must be exactly what
 * travel-gap.js accepts at commit — the candidate is the early side, so the
 * drive starts at its EXPECTED end and the buffer is reduced by its padding.
 * haversine is mocked to 3 miles here so driveOut is a real, non-zero number.
 */
const { violatesTravelGap, requiredGapMinutes } = require('../services/scheduling/travel-gap');

test('with a real drive, the packed-before-noon 11:00 is offered iff the commit probe accepts it (and it is)', async () => {
  wireDb({ stops: [stopRow('s1', '12:00', '13:00')], catalog: QUARTERLY_PEST_CATALOG });
  const { slots } = await findAvailableSlots({
    ...BASE, packEnds: true, bufferMinutes: customerFacingBufferMinutes(), serviceKey: 'quarterly_pest',
  });
  const stop = { startMin: 720, endMin: 780, lat: 27.4, lng: -82.4, windowMinutes: 60, expectedMinutes: 45 };
  const drive = requiredGapMinutes({ lat: 27.4, lng: -82.4, startMin: 660, endMin: 720, windowMinutes: 60, expectedMinutes: 45 }, stop);
  expect(drive).toBeGreaterThan(0);
  expect(drive).toBeLessThanOrEqual(15);
  const offered = slots.map((s) => s.start_time);
  expect(offered).toContain('11:00');
  // Every offered start passes the commit rule with the same credit.
  for (const s of slots) {
    const startMin = Number(s.start_time.slice(0, 2)) * 60 + Number(s.start_time.slice(3, 5));
    expect(violatesTravelGap({ startMin, endMin: startMin + 60, lat: 27.4, lng: -82.4, windowMinutes: 60, expectedMinutes: 45 }, [stop])).toBe(false);
  }
});

test('without the catalog credit the same 11:00 is refused on BOTH sides (legacy gap)', async () => {
  wireDb({ stops: [stopRow('s1', '12:00', '13:00')], catalog: NO_CATALOG_ROWS });
  const { slots } = await findAvailableSlots({ ...BASE, packEnds: true, bufferMinutes: customerFacingBufferMinutes() });
  expect(slots.map((s) => s.start_time)).not.toContain('11:00');
  const stop = { startMin: 720, endMin: 780, lat: 27.4, lng: -82.4, windowMinutes: 60, expectedMinutes: 60 };
  expect(violatesTravelGap({ startMin: 660, endMin: 720, lat: 27.4, lng: -82.4, windowMinutes: 60, expectedMinutes: 60 }, [stop])).toBe(true);
});
