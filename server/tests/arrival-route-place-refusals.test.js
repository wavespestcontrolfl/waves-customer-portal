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
function fakeTrx({ row = saveRow(), stored = storedRow(), sibling = null } = {}) {
  const writes = [];
  const trx = jest.fn(() => {
    const state = {};
    const chain = {};
    for (const m of ['leftJoin', 'whereNot', 'whereNotIn', 'whereNull', 'orWhereNull', 'orderBy', 'whereRaw']) chain[m] = () => chain;
    chain.where = (...args) => { if (args[0] === 'scheduled_services.id') state.byId = true; return chain; };
    chain.first = async (...cols) => {
      if (state.byId) return stored;
      if (cols[0] === 'scheduled_date') return row;
      return cols[0] === 'id' ? sibling : null;
    };
    chain.update = async (values) => { writes.push(values); return 1; };
    chain.select = async () => [];
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  });
  trx.isTransaction = true;
  trx.transaction = async (fn) => fn(trx);
  trx.writes = writes;
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
