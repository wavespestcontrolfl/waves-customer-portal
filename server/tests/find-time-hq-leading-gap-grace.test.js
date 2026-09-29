/**
 * find-time.js leading-gap arrival grace (prev=HQ_START, next=a REAL stop) —
 * Codex round 1 on #5310. packedBounds is called with `prev: null` for this
 * gap shape (prevIsStop is false), so its own HQ_END-style sentinel never
 * runs here: `latestFromNextStop` is computed purely from the CANDIDATE's
 * own credited work against `next`, with no idea that a graced-early
 * OFFERED start still cannot make the tech leave HQ any sooner than
 * `hqStartArrivalFloor` (dayOpen + the real HQ→candidate drive). Without a
 * matching sentinel here, a graced leading-gap offer could let the tech's
 * REAL (late) arrival run the job past `next`'s own promised start —
 * exactly the "a self-serve booking never makes an existing stop late" rule
 * (decision 5) this file must never violate.
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
// Every leg (HQ<->candidate, HQ<->stop, candidate<->stop) resolves to the
// SAME uniform drive time — haversine ignores its real coordinate args and
// always reports 20 straight-line miles, which the real (unmocked)
// milesToDriveMinutes model turns into a clean, checkable 56 minutes.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 20,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function chain(result) {
  const c = {};
  ['whereNotNull', 'whereNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
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

const STOP_COORDS = { svc_lat: 27.4, svc_lng: -82.4, cust_lat: null, cust_lng: null };
function stopRow(id, start, end) {
  return {
    id, scheduled_date: FUTURE_DATE, technician_id: 't1',
    window_start: start, window_end: end, service_type: 'pest_control', service_key_snapshot: null,
    estimated_duration_minutes: null, ...STOP_COORDS,
    first_name: 'Existing', last_name: 'Stop', city: 'Lakewood Ranch',
  };
}

function wireDb(stops) {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Adam' }]);
    if (table === 'services') return chain([]); // no catalog match -> zero padding everywhere
    return chain(stops); // scheduled_services
  });
}

// Numbers (dayOpen 08:00 = 480, every leg 56 min, 60-min candidate, 15-min
// buffer, no padding anywhere):
//   hqStartArrivalFloor = 480 + 56 = 536 (08:56) — the tech's REAL earliest
//     possible arrival, whatever start label an offer prints.
//   Real total room needed from that floor: 536 + 60 (work) + 56 (drive out)
//     + 15 (buffer) = 667 (11:07).
// next.window_start = '11:06' (666) is exactly ONE minute short of that —
// genuinely infeasible regardless of grace. next.window_start = '11:08'
// (668) clears it by one minute — genuinely feasible.
describe('leading gap (HQ_START -> a real next stop) with arrival grace', () => {
  test('an infeasible leading gap (real HQ arrival would land the job 1 minute past next\'s promise) offers NOTHING at grace, even though the pre-sentinel bound alone would have allowed it', async () => {
    wireDb([stopRow('s1', '11:06', '12:06')]);
    const { slots } = await findAvailableSlots({
      lat: 27.4, lng: -82.4, durationMinutes: 60, bufferMinutes: 15,
      dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 200,
      packEnds: true, serviceKey: 'pest_control', arrivalGraceMinutes: 90,
    });
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading).toEqual([]);
  });

  test('the identical shape ONE MINUTE more generous (real HQ arrival clears next\'s promise by exactly 1 minute) offers the graced-early hour', async () => {
    wireDb([stopRow('s1', '11:08', '12:08')]);
    const { slots } = await findAvailableSlots({
      lat: 27.4, lng: -82.4, durationMinutes: 60, bufferMinutes: 15,
      dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 200,
      packEnds: true, serviceKey: 'pest_control', arrivalGraceMinutes: 90,
    });
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading.map((s) => s.start_time)).toEqual(['08:00']);
  });

  test('grace 0 stays byte-identical: the infeasible shape already offered nothing before this fix, and still does', async () => {
    wireDb([stopRow('s1', '11:06', '12:06')]);
    const { slots } = await findAvailableSlots({
      lat: 27.4, lng: -82.4, durationMinutes: 60, bufferMinutes: 15,
      dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 200,
      packEnds: true, serviceKey: 'pest_control',
    });
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading).toEqual([]);
  });
});
