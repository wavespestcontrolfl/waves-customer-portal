/**
 * The public reschedule link keeps the visit's own technician (owner 2026-10-25, "each
 * visit stays with its own technician"; the night run, the rain pass, the office and phone
 * moves already keep it). buildAvailabilityForService is the one builder behind the GET
 * list, the find-slots search, the commit's anti-forgery rebuild and the texting AI's
 * offers, so what it asks buildBookingAvailability for is what a customer can pick. The
 * commit saves the rebuilt slot's technician, so a staff reassignment that lands between
 * the request's read and the mover's row lock must refuse, not be overwritten.
 *
 * Mocks routes/booking and services/rebooker wholesale (like
 * reschedule-public-rounds-size-rule.test.js), so it lives in its own file.
 */
const mockDb = jest.fn();
mockDb.raw = (sql) => sql;
jest.mock('../models/db', () => mockDb);
// The commit limiter (10 a minute) would throttle this file's commits.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const mockBuildBookingAvailability = jest.fn().mockResolvedValue({ days: [] });
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 }),
    resolveBookingCoords: jest.fn().mockResolvedValue({ lat: 27.4, lng: -82.4 }),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
    normalizeBookingServiceKey: jest.fn(() => ''),
    bookInsertionOffersLive: jest.fn(() => false),
  },
}));

const mockReschedule = jest.fn();
const mockRescheduleSeries = jest.fn();
jest.mock('../services/rebooker', () => ({
  reschedule: (...args) => mockReschedule(...args),
  rescheduleSeries: (...args) => mockRescheduleSeries(...args),
  leavesOwnRound: jest.fn(() => false),
}));

const express = require('express');
const { etDateString, addETDays } = require('../utils/datetime-et');
const reschedulePublicRouter = require('../routes/reschedule-public');

const { buildAvailabilityForService } = reschedulePublicRouter._test;

const RANGE = { rangeFrom: '2026-10-01', rangeTo: '2026-10-14', config: { advance_days_min: 1, advance_days_max: 14 } };
const PEST_CATALOG = { category: 'pest_control', service_key: 'quarterly_pest', name: 'Quarterly Pest Control Service' };
const ACTIVE_TECH = { employment_status: 'active', field_dispatchable: true };
const SVC = {
  id: 'svc-1',
  latitude: '27.4',
  longitude: '-82.4',
  estimated_duration_minutes: 30,
  technician_id: 'tech-a',
  service_id: 'catalog-pest',
  service_type: 'Quarterly Pest Control Service',
  service_key_snapshot: 'quarterly_pest',
};

// One chainable stand-in for every read: the technician row, the catalog row, else the visit row.
const tables = [];
function wireDb({ tech = null, catalog = PEST_CATALOG, svc = null } = {}) {
  tables.length = 0;
  mockDb.mockImplementation((table) => {
    tables.push(table);
    let value = svc;
    if (table === 'technicians') value = tech;
    else if (table === 'services') value = catalog;
    const api = { leftJoin: () => api, where: () => api, orderBy: () => api, first: async () => value };
    return api;
  });
}

const askedFor = () => mockBuildBookingAvailability.mock.calls[0][0];

const GATES = ['GATE_SERVICE_LINE_MAP', 'GATE_COLLECTIVE_SERIES_ANCHOR'];
const savedGates = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
afterAll(() => {
  for (const name of GATES) {
    if (savedGates[name] === undefined) delete process.env[name]; else process.env[name] = savedGates[name];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
  process.env.GATE_SERVICE_LINE_MAP = 'live';
  delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
});

describe('buildAvailabilityForService — the visit keeps its technician', () => {
  test('a visit whose technician can take work is offered that technician only', async () => {
    wireDb({ tech: ACTIVE_TECH });
    await buildAvailabilityForService(SVC, RANGE);

    expect(askedFor().technicianId).toBe('tech-a');
    expect(askedFor()).not.toHaveProperty('serviceLines');
  });

  test.each([
    ['is not field dispatchable', { employment_status: 'active', field_dispatchable: false }],
    ['has left (inactive)', { employment_status: 'inactive', field_dispatchable: true }],
    ['row is gone', null],
  ])('a visit whose technician %s gets the line ranking instead', async (_label, tech) => {
    wireDb({ tech });
    await buildAvailabilityForService(SVC, RANGE);

    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor().serviceLines).toEqual(['general']);
  });

  test('a visit with no technician gets the line ranking and reads no technician row', async () => {
    await buildAvailabilityForService({ ...SVC, technician_id: null }, RANGE);

    expect(tables).not.toContain('technicians');
    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor().serviceLines).toEqual(['general']);
  });

  test('the catalog row decides the line (a lawn row reads lawn whatever the name says)', async () => {
    wireDb({ catalog: { category: 'lawn_care', service_key: 'top_dress', name: 'Top Dress' } });
    await buildAvailabilityForService({ ...SVC, technician_id: null, service_type: 'Top Dress' }, RANGE);

    expect(askedFor().serviceLines).toEqual(['lawn']);
  });

  test.each(['shadow', ''])('line map %p (not live): an unassigned visit reads no line and keeps today\'s offers', async (mode) => {
    process.env.GATE_SERVICE_LINE_MAP = mode;
    await buildAvailabilityForService({ ...SVC, technician_id: null }, RANGE);

    expect(tables).toEqual([]);
    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor()).not.toHaveProperty('serviceLines');
  });

  test('line map not live: an assignable technician is still kept', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    wireDb({ tech: ACTIVE_TECH });
    await buildAvailabilityForService(SVC, RANGE);

    expect(askedFor().technicianId).toBe('tech-a');
  });

  test('an unassigned Waves Assessment gets neither rule (no line routes an assessment)', async () => {
    wireDb({ catalog: { category: 'lawn_care', service_key: 'lawn_inspection', name: 'Waves Assessment' } });
    await buildAvailabilityForService({
      ...SVC, technician_id: null, service_key_snapshot: 'lawn_inspection', service_type: 'Waves Assessment',
    }, RANGE);

    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor()).not.toHaveProperty('serviceLines');
  });
});

describe('POST /:token — a staff reassignment after the read refuses on the locked row', () => {
  const TOKEN = 'c'.repeat(64);
  const TARGET_DATE = etDateString(addETDays(new Date(), 10));
  const VISIT_DATE = etDateString(addETDays(new Date(), 12));
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/reschedule', reschedulePublicRouter);
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { server.close(done); });

  const visitRow = (over = {}) => ({
    ...SVC, customer_id: 'cust-1', status: 'confirmed', scheduled_date: VISIT_DATE,
    window_start: '08:00', window_end: '09:00', is_recurring: false, recurring_pattern: null, visit_id: null,
    customer_deleted_at: null, cust_first_name: 'Pat', customer_active: true, ...over,
  });
  const post = (row) => fetch(`${base}/api/public/reschedule/${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: TARGET_DATE, start_time: '09:00', disclosed_collective: true, disclosed_current_date: row.scheduled_date,
    }),
  });
  // The mocked mover runs the route's moveGuard against a transaction that answers the locked row read. A guard
  // that passes ends the commit with a distinct code, before the post-commit effects this file does not wire.
  const moverWith = (locked) => jest.fn(async (...args) => {
    const trx = () => ({ where: () => ({ forUpdate: () => ({ first: async () => locked }) }) });
    await args[5].moveGuard({ trx, nextVisit: null });
    throw Object.assign(new Error('guard passed'), { statusCode: 409, code: 'GUARD_PASSED', isOperational: true });
  });
  const lockedFor = (row, over = {}) => ({
    scheduled_date: row.scheduled_date, window_start: row.window_start, technician_id: row.technician_id,
    office_move_approved_for: null, recurring_pattern: row.recurring_pattern, recurring_interval_days: null,
    customer_pick_by: null, service_id: row.service_id, is_recurring: row.is_recurring, recurring_parent_id: null,
    is_callback: false, followup_included: false, date_exception: false, date_exception_cadence_date: null, ...over,
  });
  const offerTechA = () => mockBuildBookingAvailability.mockResolvedValue({
    days: [{ date: TARGET_DATE, slots: [{ start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '10:00 AM', technician_id: 'tech-a' }] }],
    slots: [],
    nearby: [],
  });
  const codeOf = async (res) => ({ status: res.status, code: (await res.json()).code });

  test.each([
    ['single move', () => visitRow(), mockReschedule],
    ['series move', () => visitRow({ is_recurring: true, recurring_pattern: 'custom' }), mockRescheduleSeries],
  ])('%s: reassigned to another technician -> 409 SLOT_TAKEN; unchanged -> the guard passes', async (_label, rowOf, mover) => {
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    const row = rowOf();
    wireDb({ tech: ACTIVE_TECH, svc: row });
    offerTechA();

    mover.mockImplementation(moverWith(lockedFor(row, { technician_id: 'tech-b' })));
    expect(await codeOf(await post(row))).toEqual({ status: 409, code: 'SLOT_TAKEN' });
    // The rebuild offered (and the mover was asked to save) the visit's own technician.
    expect(askedFor().technicianId).toBe('tech-a');
    expect(mover.mock.calls[0][5].technicianId).toBe('tech-a');

    mover.mockImplementation(moverWith(lockedFor(row)));
    expect(await codeOf(await post(row))).toEqual({ status: 409, code: 'GUARD_PASSED' });
  });

  test('an unassigned visit that staff assigned meanwhile refuses too', async () => {
    const row = visitRow({ technician_id: null });
    wireDb({ svc: row });
    offerTechA();
    mockReschedule.mockImplementation(moverWith(lockedFor(row, { technician_id: 'tech-b' })));

    expect(await codeOf(await post(row))).toEqual({ status: 409, code: 'SLOT_TAKEN' });
  });
});
