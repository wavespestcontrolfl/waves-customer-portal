/**
 * Route Check Everywhere follow-up item 1, step 0 (owner 2026-10-29, "ok go"):
 * placeMovedVisit logs ONE info line for every refusal past its gate checks,
 * so the unnumbered stops of the board have a reason on record. Log only: the
 * data writes are unchanged. The gate-off and not-in-a-transaction early
 * returns stay silent by design.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => []) }));
let mockDayRows = [];
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: () => {
    const q = { where: () => q, then: (resolve, reject) => Promise.resolve(mockDayRows).then(resolve, reject) };
    return q;
  },
  guardedCoordSelects: () => [],
  serviceLocationSelects: () => [],
  resolveServiceLocation: async (row) => ({ lat: row.lat, lng: row.lng }),
}));

const logger = require('../services/logger');
const audit = require('../services/audit-log');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { placeMovedVisit } = require('../services/scheduling/arrival-route');
const { etDateString, addETDays } = require('../utils/datetime-et');

const DATE = etDateString(addETDays(new Date(), 10));
const SERVICE = '0123456789abcdef-svc';
const GATES = ['GATE_DRIVE_TIME_CALIBRATION', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_STAFF_ROUTE_INSERTION', 'GATE_SCHEDULING_CAPACITY'];
const saved = Object.fromEntries(GATES.map(key => [key, process.env[key]]));

const saveRow = (over = {}) => ({ scheduled_date: DATE, technician_id: 'tech-1', window_start: '09:00:00', window_end: '10:00:00', ...over });
const storedRow = (over = {}) => ({
  id: SERVICE, customer_id: 'c1', technician_id: 'tech-1', scheduled_date: DATE, status: 'confirmed', window_start: '09:00:00',
  window_end: '10:00:00', estimated_duration_minutes: 60, route_order: null, created_at: '2020-01-01T12:00:00Z',
  lat: 27.5, lng: -82.4, visit_id: null, ...over,
});

// The queries placeMovedVisit reaches: the saved row (first('scheduled_date', ...)),
// the context's stored row (where('scheduled_services.id', ...)), the grouped
// probe (first('id')) and the route-number writes (update).
function fakeTrx({ row = saveRow(), stored = storedRow(), sibling = null, current = {} } = {}) {
  const writes = [];
  const writeLog = [];
  const trx = jest.fn(() => {
    const state = {};
    const chain = {};
    for (const m of ['leftJoin', 'whereNot', 'whereNotIn', 'whereNull', 'orWhereNull', 'orderBy']) chain[m] = () => chain;
    // `current` (id -> stored number) lets the number writer honor IS DISTINCT FROM.
    chain.whereRaw = (sql, bindings) => { state.next = bindings?.[0]; return chain; };
    chain.where = (...args) => {
      if (args[0] === 'scheduled_services.id') state.byId = true;
      if (args[0] && typeof args[0] === 'object') Object.assign(state, args[0].id ? { id: args[0].id } : {}, args[0].scheduled_date ? { fence: args[0] } : {});
      return chain;
    };
    chain.first = async (...cols) => {
      if (state.byId) return stored;
      if (cols[0] === 'scheduled_date') return row;
      return cols[0] === 'id' ? sibling : null;
    };
    chain.update = async (values) => {
      if (state.id in current && current[state.id] === state.next) return 0;
      writes.push(values);
      writeLog.push({ id: state.id, ...values, ...(state.fence ? { fence: state.fence } : {}) });
      return 1;
    };
    chain.select = async () => [];
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  });
  trx.isTransaction = true;
  trx.transaction = async (fn) => fn(trx);
  trx.writes = writes;
  trx.writeLog = writeLog;
  return trx;
}

const refusalLines = () => logger.info.mock.calls.map(c => c[0]).filter(l => String(l).includes('route order not placed'));
const line = (reason, source = 'estimate_accept', date = DATE) =>
  `[arrival-route] route order not placed: service=01234567 source=${source} reason=${reason} date=${date}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockDayRows = [];
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
  delete process.env.GATE_SCHEDULING_CAPACITY;
  lockTechDays.mockImplementation(async () => []);
});
afterAll(() => {
  GATES.forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
});

describe('each refusal is one info line and no write', () => {
  test.each([
    ['unassigned', { row: saveRow({ technician_id: null }) }, DATE],
    ['untimed', { row: saveRow({ window_start: null }) }, DATE],
    ['no_context', { row: null }, '-'],
    ['no_context', { stored: null }, DATE],
    ['grouped', { stored: storedRow({ visit_id: 'v1' }), sibling: { id: 'other' } }, DATE],
    ['route_unverified', { stored: storedRow({ lat: null, lng: null }) }, DATE],
  ])('%s', async (reason, fixtures, date) => {
    const trx = fakeTrx(fixtures);
    await expect(placeMovedVisit(trx, { serviceId: SERVICE, source: 'estimate_accept' })).resolves.toBeNull();
    expect(refusalLines()).toEqual([line(reason, 'estimate_accept', date)]);
    expect(trx.writes).toEqual([]);
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  test('lock_busy: the tech-day fence is held by another writer', async () => {
    lockTechDays.mockResolvedValueOnce(false);
    const trx = fakeTrx();
    await expect(placeMovedVisit(trx, { serviceId: SERVICE, source: 'dispatch_assign' })).resolves.toBeNull();
    expect(refusalLines()).toEqual([line('lock_busy', 'dispatch_assign')]);
    expect(trx.writes).toEqual([]);
  });

  test('the fit\'s own reason (two hours of work at 8 AM leaves a later stop under its margin)', async () => {
    const other = (id, start, lat, order) => storedRow({ id, customer_id: `c-${id}`, window_start: start,
      window_end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00:00`, lat, route_order: order });
    mockDayRows = [other('north', '08:00:00', 27.55, 1), other('south', '10:00:00', 27.45, 2)];
    const trx = fakeTrx({
      row: saveRow({ window_start: '08:00:00', window_end: '10:00:00' }),
      stored: storedRow({ window_start: '08:00:00', window_end: '10:00:00', estimated_duration_minutes: 120, lat: 27.545 }),
    });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toBeNull();
    expect(refusalLines()).toEqual([line('arrival_margin', '-')]);
    expect(trx.writes).toEqual([]);
  });
});

describe('what stays as it was', () => {
  test('a placed visit logs no refusal and writes its number and one audit row, as before', async () => {
    const trx = fakeTrx();
    await expect(placeMovedVisit(trx, { serviceId: SERVICE, source: 'estimate_accept' })).resolves.toEqual([SERVICE]);
    expect(refusalLines()).toEqual([]);
    expect(trx.writes).toEqual([{ route_order: 1 }]);
    expect(audit.recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'schedule.route_order_placed', resource_id: SERVICE, metadata: expect.objectContaining({ source: 'estimate_accept', route_order: [SERVICE] }),
    }));
  });

  test('the gate-off, capacity-mode and not-in-a-transaction early returns log nothing', async () => {
    const trx = fakeTrx();
    delete process.env.GATE_STAFF_ROUTE_INSERTION;
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toBeNull();
    process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toBeNull();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const outside = Object.assign(fakeTrx(), { isTransaction: false });
    await expect(placeMovedVisit(outside, { serviceId: SERVICE })).resolves.toBeNull();
    await expect(placeMovedVisit(trx, {})).resolves.toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a thrown failure keeps the existing warn line and no info line', async () => {
    const trx = Object.assign(fakeTrx(), { transaction: jest.fn(async () => { throw new Error('savepoint rolled back'); }) });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(`[arrival-route] route order not placed for ${SERVICE}: savepoint rolled back`);
    expect(refusalLines()).toEqual([]);
  });
});

// GATE_ROUTE_ORDER_TIME_FALLBACK (owner 2026-11-01, dispatch lane F1): a refused check numbers the visit by its
// arrival time among the technician's numbered stops, inside the same savepoint. Ordering only.
describe('GATE_ROUTE_ORDER_TIME_FALLBACK', () => {
  const timed = (id, start, order, over = {}) => storedRow({ id, customer_id: `c-${id}`, window_start: `${start}:00`,
    window_end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00:00`, route_order: order,
    created_at: '2020-01-01T12:00:00Z', ...over });
  const placedLine = reason => `[arrival-route] route order placed by time after refusal: service=01234567 reason=${reason}`;
  const placedLines = () => logger.info.mock.calls.map(c => c[0]).filter(l => String(l).includes('placed by time'));
  const numbers = trx => Object.fromEntries(trx.writeLog.map(w => [w.id, w.route_order]));
  const dayRows = () => [timed('s1', '08:00', 1), timed('s2', '10:00', 2), timed('s3', '13:00', 3),
    timed('o1', '09:00', 1, { technician_id: 'tech-2' }), timed('u1', '09:30', null)];
  const current = { s1: 1, s2: 2, s3: 3 };
  // No pin: the check can not verify the route (route_unverified).
  const unpinned = (over = {}) => storedRow({ lat: null, lng: null, ...over });

  beforeEach(() => { delete process.env.GATE_ROUTE_ORDER_TIME_FALLBACK; });
  afterAll(() => { delete process.env.GATE_ROUTE_ORDER_TIME_FALLBACK; });

  test('gate off: a refused check writes nothing, as before', async () => {
    mockDayRows = dayRows();
    const trx = fakeTrx({ stored: unpinned(), current });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE, source: 'estimate_accept' })).resolves.toBeNull();
    expect(refusalLines()).toEqual([line('route_unverified')]);
    expect(placedLines()).toEqual([]);
    expect(trx.writes).toEqual([]);
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  test('gate on, route_unverified: the visit takes its time slot and later stops shift by one', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = dayRows();
    const trx = fakeTrx({ stored: unpinned(), current });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE, source: 'estimate_accept' })).resolves.toEqual(['s1', SERVICE, 's2', 's3']);
    // s1 keeps 1 and is not rewritten; the other technician's and the unnumbered stop are not touched.
    expect(numbers(trx)).toEqual({ [SERVICE]: 2, s2: 3, s3: 4 });
    expect(trx.writeLog.every(w => w.fence.scheduled_date === DATE && w.fence.technician_id === 'tech-1')).toBe(true);
    expect(refusalLines()).toEqual([line('route_unverified')]);
    expect(placedLines()).toEqual([placedLine('route_unverified')]);
    expect(audit.recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'schedule.route_order_placed', resource_id: SERVICE, critical: true,
      metadata: { policy: 'route_order_time_fallback_2026_11_01', reason: 'route_unverified', source: 'estimate_accept',
        route_order: ['s1', SERVICE, 's2', 's3'] },
    }));
  });

  test('gate on: a visit before every numbered stop goes first, one after all of them goes last', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = dayRows();
    const first = fakeTrx({ row: saveRow({ window_start: '07:00:00' }), stored: unpinned({ window_start: '07:00:00' }), current });
    await expect(placeMovedVisit(first, { serviceId: SERVICE })).resolves.toEqual([SERVICE, 's1', 's2', 's3']);
    expect(numbers(first)).toEqual({ [SERVICE]: 1, s1: 2, s2: 3, s3: 4 });
    const last = fakeTrx({ row: saveRow({ window_start: '15:00:00' }), stored: unpinned({ window_start: '15:00:00' }), current });
    await expect(placeMovedVisit(last, { serviceId: SERVICE })).resolves.toEqual(['s1', 's2', 's3', SERVICE]);
    expect(numbers(last)).toEqual({ [SERVICE]: 4 });
  });

  test('gate on: a stale number on the visit is dropped and the visit moves to its time slot', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = dayRows();
    const trx = fakeTrx({ stored: unpinned({ route_order: 5 }), current: { ...current, [SERVICE]: 5 } });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual(['s1', SERVICE, 's2', 's3']);
    expect(numbers(trx)).toEqual({ [SERVICE]: 2, s2: 3, s3: 4 });
  });

  test('gate on: a day already in time order with the visit in place rewrites no row', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = dayRows();
    const trx = fakeTrx({ stored: unpinned({ route_order: 2 }), current: { s1: 1, [SERVICE]: 2, s2: 3, s3: 4 } });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual(['s1', SERVICE, 's2', 's3']);
    expect(trx.writes).toEqual([]);
  });

  test('gate on: existing stops keep their running order even when it is not time order', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = [timed('s1', '13:00', 1), timed('s2', '08:00', 2)];
    const trx = fakeTrx({ stored: unpinned({ window_start: '09:00:00' }), current: { s1: 1, s2: 2 } });
    // 13:00 is the first stop that starts later than 09:00, so the visit goes ahead of it; s2 stays behind s1.
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual([SERVICE, 's1', 's2']);
    expect(numbers(trx)).toEqual({ [SERVICE]: 1, s1: 2, s2: 3 });
  });

  test('gate on: the visit never goes ahead of a completed stop or the stop under way', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    // The technician finished 8 AM and is on site at 10 AM; a 9 AM visit saved now goes after the 10 AM stop,
    // so the customer "stops away" count still counts the stop under way (stops-ahead.js).
    mockDayRows = [timed('s1', '08:00', 1, { status: 'completed', actual_end_time: `${DATE}T12:30:00Z` }),
      timed('s2', '10:00', 2, { status: 'on_site' }), timed('s3', '13:00', 3)];
    const trx = fakeTrx({ stored: unpinned(), current });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual(['s1', 's2', SERVICE, 's3']);
    expect(numbers(trx)).toEqual({ [SERVICE]: 3, s3: 4 });
    expect(placedLines()).toHaveLength(1);
    // Stops done out of order: a pending 8 AM stop numbered ahead of a completed 9:30 stop keeps its place,
    // and the visit goes after the completed stop.
    mockDayRows = [timed('p1', '08:00', 1), timed('c2', '09:30', 2, { status: 'completed', actual_end_time: `${DATE}T14:00:00Z` }),
      timed('s3', '13:00', 3)];
    const late = fakeTrx({ stored: unpinned(), current: { p1: 1, c2: 2, s3: 3 } });
    await expect(placeMovedVisit(late, { serviceId: SERVICE })).resolves.toEqual(['p1', 'c2', SERVICE, 's3']);
    expect(numbers(late)).toEqual({ [SERVICE]: 3, s3: 4 });
  });

  test('gate on: a visit that is itself under way keeps its number', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = dayRows();
    const trx = fakeTrx({ stored: unpinned({ status: 'on_site', route_order: 3 }), current: { ...current, [SERVICE]: 3 } });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toBeNull();
    expect(trx.writes).toEqual([]);
    expect(placedLines()).toEqual([]);
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  test('gate on: untimed, unassigned, no_context, lock_busy and grouped refusals still write nothing', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = dayRows();
    const cases = [
      { row: saveRow({ window_start: null }) },
      { row: saveRow({ technician_id: null }) },
      { row: null },
      { stored: null },
      { stored: storedRow({ visit_id: 'v1' }), sibling: { id: 'other' } },
    ];
    for (const fixtures of cases) {
      const trx = fakeTrx({ ...fixtures, current });
      await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toBeNull();
      expect(trx.writes).toEqual([]);
    }
    lockTechDays.mockResolvedValueOnce(false);
    const busy = fakeTrx({ current });
    await expect(placeMovedVisit(busy, { serviceId: SERVICE })).resolves.toBeNull();
    expect(busy.writes).toEqual([]);
    expect(placedLines()).toEqual([]);
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  test('gate on: a placed visit (the check passed) is written by the check, not by the fallback', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    const trx = fakeTrx();
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual([SERVICE]);
    expect(placedLines()).toEqual([]);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ policy: 'staff_route_insertion_2026_10_25' }) }));
  });

  test('gate on, arrival_margin refusal (the check ran and refused): the same time-slot rule', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    // Two hours of work at 8 AM leaves the 10 AM stop under its margin (the refusal above), so the check refuses.
    const other = (id, start, lat, order) => timed(id, start, order, { lat });
    mockDayRows = [other('north', '08:00', 27.55, 1), other('south', '10:00', 27.45, 2)];
    const trx = fakeTrx({
      row: saveRow({ window_start: '08:00:00', window_end: '10:00:00' }),
      stored: storedRow({ window_start: '08:00:00', window_end: '10:00:00', estimated_duration_minutes: 120, lat: 27.545 }),
      current: { north: 1, south: 2 },
    });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual(['north', SERVICE, 'south']);
    expect(refusalLines()).toEqual([line('arrival_margin', '-')]);
    expect(placedLines()).toEqual([placedLine('arrival_margin')]);
    expect(numbers(trx)).toEqual({ [SERVICE]: 2, south: 3 });
  });

  test('gate on: a same-customer, same-window, same-pin sibling takes the visit right after it', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    // Two stops at 8 AM at opposite ends of the county cannot both keep their promise: the check refuses.
    mockDayRows = [timed('far-n', '08:00', 1, { lat: 28.2 }), timed('far-s', '08:00', 2, { lat: 26.9 }),
      timed('sib', '10:00', 3, { customer_id: 'c1', lat: 27.5, service_address_line1: '100 Test Way', service_address_zip: '34201' }), timed('after', '10:00', 4, { lat: 27.5 })];
    const trx = fakeTrx({ row: saveRow({ window_start: '10:00:00', window_end: '11:00:00' }),
      stored: storedRow({ window_start: '10:00:00', window_end: '11:00:00', service_address_line1: '100 Test Way', service_address_zip: '34201' }), current: { 'far-n': 1, 'far-s': 2, sib: 3, after: 4 } });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual(['far-n', 'far-s', 'sib', SERVICE, 'after']);
    expect(refusalLines()).toEqual([line('arrival_window', '-')]);
    expect(placedLines()).toEqual([placedLine('arrival_window')]);
    expect(numbers(trx)).toEqual({ [SERVICE]: 4, after: 5 });
  });

  test('gate on: a same-window stop of another customer is not a sibling, so the visit goes ahead of the first later stop', async () => {
    process.env.GATE_ROUTE_ORDER_TIME_FALLBACK = 'true';
    mockDayRows = [timed('far-n', '08:00', 1, { lat: 28.2 }), timed('far-s', '08:00', 2, { lat: 26.9 }),
      timed('other', '10:00', 3, { lat: 27.5 }), timed('after', '11:00', 4, { lat: 27.5 })];
    const trx = fakeTrx({ row: saveRow({ window_start: '10:00:00', window_end: '11:00:00' }),
      stored: storedRow({ window_start: '10:00:00', window_end: '11:00:00' }), current: { 'far-n': 1, 'far-s': 2, other: 3, after: 4 } });
    await expect(placeMovedVisit(trx, { serviceId: SERVICE })).resolves.toEqual(['far-n', 'far-s', 'other', SERVICE, 'after']);
    expect(numbers(trx)).toEqual({ [SERVICE]: 4, after: 5 });
  });
});
