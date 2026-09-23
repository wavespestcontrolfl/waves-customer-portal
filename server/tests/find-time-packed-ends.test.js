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
  haversine: () => 0,
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

describe('H1 — leading gap (day-open before the first stop)', () => {
  const stops = [
    stopRow('s1', '12:00', '13:00'),
    stopRow('s2', '13:00', '14:00'),
    stopRow('s3', '15:00', '16:00'),
    stopRow('s4', '16:00', '17:00'),
  ];

  test('OLD gap rule (no catalog match): the leading gap packs to 10:00 — 9:00 is never offered', async () => {
    wireDb({ stops, catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    expect(slots.some((s) => s.start_time === '09:00')).toBe(false);
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading.map((s) => s.start_time)).toEqual(['10:00']);
  });

  test('NEW expected-minutes rule (quarterly-pest catalog match): the leading gap packs to 11:00', async () => {
    wireDb({ stops, catalog: QUARTERLY_PEST_CATALOG });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceType: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    expect(slots.some((s) => s.start_time === '09:00')).toBe(false);
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading.map((s) => s.start_time)).toEqual(['11:00']);
  });
});

describe('H5 — middle gap (idle time between two stops)', () => {
  const stops = [stopRow('s1', '09:00', '10:00'), stopRow('s2', '14:00', '15:00')];

  test('offers exactly the two packed ends (11:00 after s1, 12:00 before s2), never the hole-making hours between', async () => {
    wireDb({ stops, catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    const middleGap = slots.filter((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id === 's2');
    expect(middleGap.map((s) => s.start_time).sort()).toEqual(['11:00', '12:00']);
  });
});

describe('trailing gap (last stop before day-close)', () => {
  test('offers ONLY its earliest packed start', async () => {
    wireDb({ stops: [stopRow('s1', '09:00', '10:00')], catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    const trailing = slots.filter((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id == null);
    expect(trailing.map((s) => s.start_time)).toEqual(['11:00']);
  });
});

describe('empty day (no stops at all)', () => {
  test('packEnds has no effect — the single exact-minute legacy candidate is unchanged', async () => {
    wireDb({ stops: [], catalog: NO_CATALOG_ROWS });
    const withPackEnds = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control', bufferMinutes: customerFacingBufferMinutes(),
    });
    const legacy = await findAvailableSlots({ ...BASE });
    expect(withPackEnds.slots).toHaveLength(1);
    expect(withPackEnds.slots[0].start_time).toBe('08:00');
    expect(withPackEnds.slots[0].stops_that_day).toBe(0);
    expect(legacy.slots[0].start_time).toBe('08:00');
  });
});

describe('legacy callers (packEnds omitted) stay byte-identical on a stop day', () => {
  test('every gap still emits exactly one earliest-feasible candidate', async () => {
    const stops = [stopRow('s1', '09:00', '10:00'), stopRow('s2', '14:00', '15:00')];
    wireDb({ stops, catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({ ...BASE, bufferMinutes: customerFacingBufferMinutes() });
    // Three gaps (leading, middle, trailing) -> one earliest-feasible
    // candidate each, EXCEPT the leading gap: an 08:00 start plus the
    // 60-min job plus the 15-min buffer would land past the 09:00 stop, so
    // it correctly yields none (legacy and packed-ends agree here).
    expect(slots).toHaveLength(2);
    const middleGap = slots.find((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id === 's2');
    expect(middleGap.start_time).toBe('10:15'); // 10:00 + 0 drive + 15 buffer, unsnapped
  });
});
