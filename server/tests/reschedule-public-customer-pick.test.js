/**
 * Quick Move "let the customer pick a day" (owner 2026-11-01) on the public
 * reschedule GET: `customerPick` for a visit handed to the customer and still
 * waiting (marker set, no window), `autoPlacedFromPick` once Auto-Dispatch booked
 * it after the pick-by instant, and the 6-time curated list for a waiting visit
 * only. Every other visit keeps its payload, its query count and the default 4.
 *
 * Isolated like reschedule-public-place-in-route.test.js: it mocks routes/booking
 * wholesale, which reschedule-public.test.js must not inherit.
 */
const fs = require('fs');
const path = require('path');

const mockDb = jest.fn();
mockDb.raw = (sql) => sql;
jest.mock('../models/db', () => mockDb);
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { etDateString, addETDays } = require('../utils/datetime-et');

const mockConfig = { advance_days_min: 1, advance_days_max: 14 };
const mockBuildBookingAvailability = jest.fn();
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn().mockResolvedValue(mockConfig),
    resolveBookingCoords: jest.fn().mockResolvedValue({ lat: 27.4, lng: -82.4 }),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
    normalizeBookingServiceKey: jest.fn(() => ''),
    bookInsertionOffersLive: jest.fn(() => false),
  },
}));

const express = require('express');
const logger = require('../services/logger');
const reschedulePublicRouter = require('../routes/reschedule-public');

const { customerPickFields, pickByLabel, pickSlotCount, buildAvailabilityForService } = reschedulePublicRouter._test;

// Real near-future dates: the GET's booking range and eligibility read the real clock.
const PARKED_DATE = etDateString(addETDays(new Date(), 8));
const PLACED_DATE = etDateString(addETDays(new Date(), 10));
const PICK_BY = new Date('2026-11-05T01:00:00Z'); // Wed, Nov 4 at 8 PM ET
const FAR_PICK_BY = new Date('2099-11-05T01:00:00Z'); // also a Wednesday, Nov 4 at 8 PM ET
// The hand-off's row as a Quick Move logs it: reason_code = why it moved, notes marks the hand-off.
const PICK_LOG = { original_date: '2026-11-03', original_window: '09:00:00-11:00:00', reason_code: 'weather_rain', notes: 'customer_pick' };

function svcRow(overrides = {}) {
  return {
    id: 'svc-1', customer_id: 'cust-1', status: 'pending', scheduled_date: PARKED_DATE,
    window_start: null, window_end: null, service_type: 'Quarterly Pest Control Service',
    service_key_snapshot: 'quarterly_pest', estimated_duration_minutes: 60,
    is_recurring: true, recurring_parent_id: 'plan-1', recurring_pattern: 'quarterly', visit_id: null,
    customer_deleted_at: null, customer_active: true, cust_first_name: 'Pat',
    latitude: '27.4', longitude: '-82.4',
    customer_pick_by: null, last_auto_dispatch_at: null,
    ...overrides,
  };
}

const waitingSvc = (overrides = {}) => svcRow({ customer_pick_by: FAR_PICK_BY, ...overrides });
const placedSvc = (overrides = {}) => svcRow({
  scheduled_date: PLACED_DATE, window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed',
  customer_pick_by: new Date('2026-10-30T00:00:00Z'), last_auto_dispatch_at: new Date('2026-10-31T08:10:00Z'),
  ...overrides,
});

// One chain per table: the visit (selectSvc) and its reschedule_log rows. `pickLog`
// may be an Error to make the log read fail.
let logQueries;
function wireDb({ svc = null, pickLog = null } = {}) {
  logQueries = [];
  mockDb.mockImplementation((table) => {
    const isLog = table === 'reschedule_log';
    const api = {
      leftJoin: () => api,
      where: (...args) => { if (isLog) logQueries.push(args[0]); return api; },
      orderBy: () => api,
      first: async () => {
        if (!isLog) return svc;
        if (pickLog instanceof Error) throw pickLog;
        return pickLog;
      },
    };
    return api;
  });
}

const AVAILABILITY = {
  days: [{ date: PLACED_DATE, fullDate: 'Some day', slots: [{ start_time: '09:00', start_label: '9:00 AM' }] }],
  slots: [{ date: PLACED_DATE, start_time: '09:00' }],
  nearby: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildBookingAvailability.mockResolvedValue(AVAILABILITY);
});

describe('customerPickFields — the payload story for a handed-off visit', () => {
  test('waiting before the deadline: pick-by instant and label, the original slot and the Quick Move reason', async () => {
    wireDb({ pickLog: PICK_LOG });
    const fields = await customerPickFields(svcRow({ customer_pick_by: PICK_BY }), new Date('2026-11-04T15:00:00Z'));
    expect(fields).toEqual({
      customerPick: {
        pickBy: '2026-11-05T01:00:00.000Z',
        pickByLabel: 'Wed, Nov 4 at 8 PM',
        deadlinePassed: false,
        originalDate: '2026-11-03',
        originalWindowStart: '09:00',
        reasonCode: 'weather_rain',
      },
    });
    // The newest hand-off row only: the visit, then notes 'customer_pick' OR the first shape's reason_code.
    expect(logQueries[0]).toEqual({ scheduled_service_id: 'svc-1' });
    const calls = [];
    const q = { where: (...a) => { calls.push(['where', ...a]); return q; }, orWhere: (...a) => { calls.push(['orWhere', ...a]); return q; } };
    logQueries[1].call(q);
    expect(calls).toEqual([['where', 'notes', 'customer_pick'], ['orWhere', 'reason_code', 'customer_pick']]);
  });

  test('a hand-off row in the first shape (reason_code customer_pick, the reason in notes) reads the same', async () => {
    wireDb({ pickLog: { original_date: '2026-11-03', original_window: '09:00:00-11:00:00', reason_code: 'customer_pick', notes: 'gate_locked' } });
    const fields = await customerPickFields(svcRow({ customer_pick_by: PICK_BY }), new Date('2026-11-04T15:00:00Z'));
    expect(fields.customerPick).toEqual(expect.objectContaining({ originalDate: '2026-11-03', originalWindowStart: '09:00', reasonCode: 'gate_locked' }));
  });

  test('the deadline passes AT the pick-by instant, and stays passed after it', async () => {
    wireDb({ pickLog: PICK_LOG });
    const svc = svcRow({ customer_pick_by: PICK_BY });
    expect((await customerPickFields(svc, new Date(PICK_BY.getTime() - 1))).customerPick.deadlinePassed).toBe(false);
    expect((await customerPickFields(svc, PICK_BY)).customerPick.deadlinePassed).toBe(true);
    expect((await customerPickFields(svc, new Date('2026-11-05T09:00:00Z'))).customerPick.deadlinePassed).toBe(true);
  });

  test('no hand-off row, or a failed read: the original slot and reason are null and the pick-by fields stay', async () => {
    for (const pickLog of [null, new Error('db down')]) {
      wireDb({ pickLog });
      const fields = await customerPickFields(svcRow({ customer_pick_by: PICK_BY }), new Date('2026-11-04T15:00:00Z'));
      expect(fields.customerPick).toEqual(expect.objectContaining({
        pickByLabel: 'Wed, Nov 4 at 8 PM', originalDate: null, originalWindowStart: null, reasonCode: null,
      }));
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('reasonCode is a Quick Move reason code (reason_code; notes on a first-shape row), or null for any other text', async () => {
    const cases = [['running_late', 'running_late'], [' weather_wind ', 'weather_wind'], ['custom', 'custom'],
      ['Moved by Quick Move: rain', null], ['', null], [null, null]];
    for (const [value, want] of cases) {
      for (const shape of [{ reason_code: value, notes: 'customer_pick' }, { reason_code: 'customer_pick', notes: value }]) {
        wireDb({ pickLog: { ...PICK_LOG, ...shape } });
        const fields = await customerPickFields(svcRow({ customer_pick_by: PICK_BY }), new Date('2026-11-04T15:00:00Z'));
        expect(fields.customerPick.reasonCode).toBe(want);
      }
    }
  });

  test('a windowless original slot reads as a null window start', async () => {
    wireDb({ pickLog: { ...PICK_LOG, original_window: null } });
    const fields = await customerPickFields(svcRow({ customer_pick_by: PICK_BY }), new Date('2026-11-04T15:00:00Z'));
    expect(fields.customerPick).toEqual(expect.objectContaining({ originalDate: '2026-11-03', originalWindowStart: null }));
  });

  test('auto-placed after the deadline: from = the hand-off row\'s original slot, to = the visit now; no customerPick', async () => {
    wireDb({ pickLog: PICK_LOG });
    expect(await customerPickFields(placedSvc())).toEqual({
      autoPlacedFromPick: {
        from: { date: '2026-11-03', windowStart: '09:00' },
        to: { date: PLACED_DATE, windowStart: '09:00' },
      },
    });
    wireDb({ pickLog: null });
    expect((await customerPickFields(placedSvc())).autoPlacedFromPick.from).toBeNull();
  });

  test('no story (and no log query) for a visit without the marker, or with an Auto-Dispatch stamp from before the hand-off', async () => {
    wireDb({ pickLog: PICK_LOG });
    expect(await customerPickFields(svcRow())).toEqual({});
    expect(await customerPickFields(svcRow({ window_start: '09:00:00' }))).toEqual({});
    expect(await customerPickFields(placedSvc({ last_auto_dispatch_at: new Date('2026-10-29T08:10:00Z') }))).toEqual({});
    expect(await customerPickFields(placedSvc({ last_auto_dispatch_at: null }))).toEqual({});
    expect(logQueries).toEqual([]);
  });

  test('a windowless visit with the marker is still waiting even when an Auto-Dispatch run already tried it', async () => {
    wireDb({ pickLog: PICK_LOG });
    const fields = await customerPickFields(
      svcRow({ customer_pick_by: PICK_BY, last_auto_dispatch_at: new Date('2026-11-06T09:10:00Z') }),
      new Date('2026-11-06T12:00:00Z'),
    );
    expect(fields.customerPick.deadlinePassed).toBe(true);
    expect(fields.autoPlacedFromPick).toBeUndefined();
  });
});

describe('pickByLabel — ET wording', () => {
  test.each([
    ['2026-11-05T01:00:00Z', 'Wed, Nov 4 at 8 PM'],
    ['2026-11-05T01:30:00Z', 'Wed, Nov 4 at 8:30 PM'],
    ['2026-11-04T17:00:00Z', 'Wed, Nov 4 at 12 PM'],
    ['2026-11-05T05:00:00Z', 'Thu, Nov 5 at 12 AM'],
    // Daylight time: 8 PM EDT.
    ['2026-07-02T00:00:00Z', 'Wed, Jul 1 at 8 PM'],
  ])('%s → %s', (iso, label) => {
    expect(pickByLabel(new Date(iso))).toBe(label);
  });
});

describe('the 6-time curated list is for a waiting visit only', () => {
  test('pickSlotCount: 6 while waiting; no key for an auto-placed or ordinary visit', () => {
    expect(pickSlotCount(waitingSvc())).toEqual({ bestSlotCount: 6 });
    expect(pickSlotCount(placedSvc())).toEqual({});
    expect(pickSlotCount(svcRow())).toEqual({});
  });

  test('buildAvailabilityForService (behind GET, find-slots and the SLOT_TAKEN refresh) asks for 6 only while waiting', async () => {
    const range = { rangeFrom: '2026-11-02', rangeTo: '2026-11-15', config: mockConfig };
    await buildAvailabilityForService(waitingSvc(), range);
    expect(mockBuildBookingAvailability.mock.calls[0][0]).toEqual(expect.objectContaining({ bestSlotCount: 6 }));
    await buildAvailabilityForService(placedSvc(), range);
    await buildAvailabilityForService(svcRow(), range);
    expect(mockBuildBookingAvailability.mock.calls[1][0]).not.toHaveProperty('bestSlotCount');
    expect(mockBuildBookingAvailability.mock.calls[2][0]).not.toHaveProperty('bestSlotCount');
  });

  test('no other server caller passes bestSlotCount (the phone agent relies on at most 4)', () => {
    const root = path.join(__dirname, '..');
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('bestSlotCount')) hits.push(path.relative(root, full));
      }
    };
    walk(path.join(root, 'routes'));
    walk(path.join(root, 'services'));
    expect(hits.sort()).toEqual(['routes/booking.js', 'routes/reschedule-public.js']);
  });
});

describe('GET /api/public/reschedule/:token', () => {
  const TOKEN = 'a'.repeat(64);
  let server;
  let base;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/reschedule', reschedulePublicRouter);
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { server.close(done); });

  async function getPage() {
    const res = await fetch(`${base}/api/public/reschedule/${TOKEN}`);
    return { status: res.status, body: await res.json() };
  }

  test('a waiting visit is reschedulable, carries customerPick and asks for 6 times', async () => {
    wireDb({ svc: waitingSvc(), pickLog: PICK_LOG });
    const { status, body } = await getPage();
    expect(status).toBe(200);
    expect(body.state).toBe('reschedulable');
    expect(body.customerPick).toEqual({
      pickBy: '2099-11-05T01:00:00.000Z',
      pickByLabel: 'Wed, Nov 4 at 8 PM',
      deadlinePassed: false,
      originalDate: '2026-11-03',
      originalWindowStart: '09:00',
      reasonCode: 'weather_rain',
    });
    expect(body).not.toHaveProperty('autoPlacedFromPick');
    // A handed-off visit is a single move: no series disclosure.
    expect(body.collectiveAnchor).toBe(false);
    expect(body.reanchorPullForwardDays).toBeNull();
    expect(body.availability.slots).toEqual(AVAILABILITY.slots);
    expect(mockBuildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({ bestSlotCount: 6 }));
  });

  test('an auto-placed visit carries autoPlacedFromPick and keeps the default count', async () => {
    wireDb({ svc: placedSvc(), pickLog: PICK_LOG });
    const { body } = await getPage();
    expect(body.state).toBe('reschedulable');
    expect(body.autoPlacedFromPick).toEqual({
      from: { date: '2026-11-03', windowStart: '09:00' },
      to: { date: PLACED_DATE, windowStart: '09:00' },
    });
    expect(body).not.toHaveProperty('customerPick');
    expect(mockBuildBookingAvailability.mock.calls[0][0]).not.toHaveProperty('bestSlotCount');
  });

  test('an ordinary visit: neither key, no hand-off query, default count', async () => {
    wireDb({ svc: svcRow({ scheduled_date: PLACED_DATE, window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed' }), pickLog: PICK_LOG });
    const { body } = await getPage();
    expect(body.state).toBe('reschedulable');
    expect(body).not.toHaveProperty('customerPick');
    expect(body).not.toHaveProperty('autoPlacedFromPick');
    expect(logQueries).toEqual([]);
    expect(mockBuildBookingAvailability.mock.calls[0][0]).not.toHaveProperty('bestSlotCount');
  });

  test('a not-reschedulable handed-off visit returns no pick story (the page shows its refusal card)', async () => {
    wireDb({ svc: waitingSvc({ customer_active: false }), pickLog: PICK_LOG });
    const { body } = await getPage();
    expect(body.state).toBe('not_reschedulable');
    expect(body).not.toHaveProperty('customerPick');
    expect(logQueries).toEqual([]);
  });
});
