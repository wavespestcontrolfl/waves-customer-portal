/**
 * POST /:token — the lawn rounds size rule (owner 2026-10-31): a lawn_rounds_9 visit moves ALONE for a
 * date within 7 days of its regular date inside its round (single mover, no series move), a bigger move
 * re-anchors as before, and the commit pins the rule the page disclosed (`disclosed_rounds_one_off`).
 * Every other series keeps its behavior with no disclosure. Same isolation as
 * reschedule-public-place-in-route.test.js: routes/booking and services/rebooker are mocked wholesale.
 */
const mockDb = jest.fn();
mockDb.raw = (sql) => sql;
jest.mock('../models/db', () => mockDb);
// The commit limiter (10 a minute) would throttle this file's many commits.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const { etDateString, addETDays } = require('../utils/datetime-et');
const { roundOf } = require('../services/lawn-rounds');
const TARGET_DATE = etDateString(addETDays(new Date(), 10));
// The visit sits 3 days from the target, on the side that keeps both inside one round.
const VISIT_DATE = [3, -3]
  .map((d) => etDateString(addETDays(new Date(), 10 + d)))
  .find((d) => roundOf(d).start === roundOf(TARGET_DATE).start);
// And one 10 days away: a bigger move whatever the round.
const FAR_VISIT_DATE = etDateString(addETDays(new Date(), 20));
jest.mock('../routes/booking', () => {
  const { etDateString: ymd, addETDays: plus } = require('../utils/datetime-et');
  return {
  _internals: {
    loadBookingConfig: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 }),
    resolveBookingCoords: jest.fn().mockResolvedValue({ lat: 27.4, lng: -82.4 }),
    buildBookingAvailability: jest.fn().mockImplementation(async () => ({
      days: [{ date: ymd(plus(new Date(), 10)), slots: [{ start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '10:00 AM', technician_id: 'tech-1' }] }],
      slots: [], nearby: [],
    })),
    normalizeBookingServiceKey: jest.fn(() => 'lawn_care'),
    bookInsertionOffersLive: jest.fn(() => false),
  },
  };
});

const mockReschedule = jest.fn();
const mockRescheduleSeries = jest.fn();
jest.mock('../services/rebooker', () => ({
  reschedule: (...args) => mockReschedule(...args),
  rescheduleSeries: (...args) => mockRescheduleSeries(...args),
  leavesOwnRound: jest.fn(() => false),
}));

const express = require('express');
const reschedulePublicRouter = require('../routes/reschedule-public');
const TOKEN = 'b'.repeat(64);
let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/public/reschedule', reschedulePublicRouter);
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const roundsRow = (over = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: VISIT_DATE,
  window_start: '08:00', window_end: '09:00', service_type: 'Lawn Care',
  is_recurring: true, recurring_pattern: 'lawn_rounds_9', visit_id: null, customer_deleted_at: null, cust_first_name: 'Pat',
  customer_active: true, ...over,
});
function wireSvc(svc) {
  mockDb.mockImplementation(() => {
    const api = { leftJoin: () => api, where: () => api, orderBy: () => api, first: async () => svc };
    return api;
  });
}
const termsFor = (row) => {
  const home = roundOf(row.scheduled_date);
  return { maxDays: 7, fromDate: row.scheduled_date, roundStart: home.start, roundEnd: home.end };
};
const post = (row, extra = {}) => fetch(`${base}/api/public/reschedule/${TOKEN}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    date: TARGET_DATE, start_time: '09:00', disclosed_collective: true, disclosed_current_date: row.scheduled_date, ...extra,
  }),
});
const stop = () => Object.assign(new Error('stop after the call'), { statusCode: 409, code: 'SLOT_TAKEN', isOperational: true });

let savedGate;
beforeEach(() => {
  jest.clearAllMocks();
  savedGate = process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
  process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
  mockReschedule.mockRejectedValue(stop());
  mockRescheduleSeries.mockRejectedValue(stop());
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
  else process.env.GATE_COLLECTIVE_SERIES_ANCHOR = savedGate;
});

describe('POST /:token — lawn rounds size rule', () => {
  test('a date within 7 days inside the round moves only this visit', async () => {
    const row = roundsRow();
    wireSvc(row);
    await post(row, { disclosed_rounds_one_off: termsFor(row) });
    expect(mockRescheduleSeries).not.toHaveBeenCalled();
    expect(mockReschedule).toHaveBeenCalledTimes(1);
    expect(mockReschedule.mock.calls[0][5]).toMatchObject({ seriesPolicy: 'single' });
  });

  test('a bigger move re-anchors the series as before', async () => {
    const row = roundsRow({ scheduled_date: FAR_VISIT_DATE });
    wireSvc(row);
    await post(row, { disclosed_rounds_one_off: termsFor(row) });
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockRescheduleSeries).toHaveBeenCalledTimes(1);
  });

  test('a rounds visit whose page omitted the disclosure, or sent another rule, gets SCOPE_CHANGED and nothing moves', async () => {
    const row = roundsRow();
    wireSvc(row);
    for (const extra of [{}, { disclosed_rounds_one_off: null }, { disclosed_rounds_one_off: { ...termsFor(row), maxDays: 14 } }]) {
      const res = await post(row, extra);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('SCOPE_CHANGED');
    }
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockRescheduleSeries).not.toHaveBeenCalled();
  });

  test('another series pattern keeps the series move for the same short move, with no disclosure asked for', async () => {
    const row = roundsRow({ recurring_pattern: 'custom' });
    wireSvc(row);
    await post(row);
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockRescheduleSeries).toHaveBeenCalledTimes(1);
  });
});

// The page's single-versus-series decision was made on the unlocked read. A series re-anchor can change a
// date exception's cadence date while the date and window the expect fence pins stay put, so BOTH commit
// paths (and a missed visit) judge the disclosed rule again on the LOCKED row, inside the mover's guard.
describe('POST /:token — the size rule is re-judged on the locked row', () => {
  // The mocked mover runs the route's moveGuard against a transaction that answers the locked row read.
  const moverWith = (locked) => jest.fn(async (...args) => {
    const trx = () => ({ where: () => ({ forUpdate: () => ({ first: async () => locked }) }) });
    await args[5].moveGuard({ trx, nextVisit: null });
    // The guard passed: stop here (SLOT_TAKEN), before the post-commit effects this file does not wire.
    throw stop();
  });
  const guardPassed = async (res, mover) => {
    expect(mover).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SLOT_TAKEN');
  };
  const lockedFor = (row, over = {}) => ({
    scheduled_date: row.scheduled_date, window_start: row.window_start, office_move_approved_for: null,
    recurring_pattern: 'lawn_rounds_9', recurring_interval_days: null, service_id: null, is_recurring: true,
    recurring_parent_id: null, is_callback: false, followup_included: false, date_exception: false, date_exception_cadence_date: null, ...over,
  });
  const MOVED_CADENCE = { date_exception: true, date_exception_cadence_date: '2000-01-01' };
  const scopeChanged = async (res) => { expect(res.status).toBe(409); expect((await res.json()).code).toBe('SCOPE_CHANGED'); };

  test('single path: a cadence date changed between the preflight and the lock -> SCOPE_CHANGED; unchanged commits', async () => {
    const row = roundsRow();
    wireSvc(row);
    mockReschedule.mockImplementation(moverWith(lockedFor(row, MOVED_CADENCE)));
    await scopeChanged(await post(row, { disclosed_rounds_one_off: termsFor(row) }));
    mockReschedule.mockClear();
    const unchanged = moverWith(lockedFor(row));
    mockReschedule.mockImplementation(unchanged);
    await guardPassed(await post(row, { disclosed_rounds_one_off: termsFor(row) }), unchanged);
  });

  test('series path: the same race -> SCOPE_CHANGED; unchanged commits', async () => {
    const row = roundsRow({ scheduled_date: FAR_VISIT_DATE });
    wireSvc(row);
    mockRescheduleSeries.mockImplementation(moverWith(lockedFor(row, MOVED_CADENCE)));
    await scopeChanged(await post(row, { disclosed_rounds_one_off: termsFor(row) }));
    mockRescheduleSeries.mockClear();
    const unchanged = moverWith(lockedFor(row));
    mockRescheduleSeries.mockImplementation(unchanged);
    await guardPassed(await post(row, { disclosed_rounds_one_off: termsFor(row) }), unchanged);
  });

  test('missed visit: the locked-row check still runs (it comes before the missed exemption)', async () => {
    const past = etDateString(addETDays(new Date(), -2));
    const row = roundsRow({ status: 'pending', scheduled_date: past });
    wireSvc(row);
    mockRescheduleSeries.mockImplementation(moverWith(lockedFor(row, MOVED_CADENCE)));
    await scopeChanged(await post(row, { disclosed_rounds_one_off: termsFor(row) }));
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/reschedule-public.js'), 'utf8');
    const recheck = src.slice(src.indexOf('const officeApprovalRecheck = async'));
    expect(recheck.indexOf('roundsOneOffMismatch(locked, req.body)')).toBeLessThan(recheck.indexOf('if (elig.missed) return;'));
  });

  test('a non-rounds series visit is unaffected: no disclosure asked for, the guard passes', async () => {
    const row = roundsRow({ recurring_pattern: 'custom' });
    wireSvc(row);
    const mover = moverWith(lockedFor(row, { recurring_pattern: 'custom', ...MOVED_CADENCE }));
    mockRescheduleSeries.mockImplementation(mover);
    await guardPassed(await post(row), mover);
  });
});
