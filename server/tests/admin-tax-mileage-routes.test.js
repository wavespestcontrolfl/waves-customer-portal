/**
 * Tax > Assets > Mileage routes (accounting audit 2026-10-30):
 *  - POST /mileage takes the Mileage tab's body (tripDate, distanceMiles as
 *    typed) and refuses a bad date or a distance that is not a positive
 *    number (ACC-03, ACC-07), before any rate lookup or insert.
 *  - POST /mileage/sync-bouncie with no dates (the Sync from Bouncie button) syncs
 *    the last 7 Eastern days through today; explicit dates are checked
 *    (ACC-04).
 *  - GET /mileage/stats without a year reads the Eastern year (ACC-11).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const inserts = [];
const whereCalls = [];
const mockDb = jest.fn((table) => {
  const b = {};
  b.where = jest.fn((...args) => { whereCalls.push([table, ...args]); return b; });
  b.whereNotNull = jest.fn(() => b);
  b.select = jest.fn(() => b);
  b.sum = jest.fn(() => b);
  b.count = jest.fn(() => b);
  b.groupBy = jest.fn(() => b);
  b.orderBy = jest.fn(async () => []);
  b.first = jest.fn(async () => ({ total_miles: '0', total_deduction: '0', trip_count: '0' }));
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  b.insert = jest.fn((row) => {
    inserts.push([table, row]);
    return { returning: jest.fn(async () => [{ id: 'mileage-1', ...row }]) };
  });
  return b;
});
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: jest.fn(() => 'now()') };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  requireAdmin: (_req, _res, next) => next(),
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: jest.fn(),
}));
jest.mock('../services/expense-categorizer', () => ({ autoCategorizeExpense: jest.fn(), categoryDeductibleAmount: jest.fn() }));
jest.mock('../services/bouncie-mileage', () => ({ getIrsRate: jest.fn(() => 0.7) }));
jest.mock('../services/bouncie', () => ({
  syncMileage: jest.fn(async () => ({ tripsImported: 2, totalMiles: 18.4, deductionAmount: 12.88, skipped: 1 })),
}));
jest.mock('../services/bank-import', () => ({}));
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn() }));

const express = require('express');
const BouncieService = require('../services/bouncie');
const mileageService = require('../services/bouncie-mileage');
const taxRouter = require('../routes/admin-tax');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  inserts.length = 0;
  whereCalls.length = 0;
  jest.clearAllMocks();
});

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}/admin/tax${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// Only Date is faked: the test server's sockets keep their real timers.
const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const atInstant = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: ALL_BUT_DATE });
afterEach(() => jest.useRealTimers());

describe('POST /admin/tax/mileage', () => {
  test('the Mileage tab body saves: date, typed miles, addresses, deduction at the date rate', async () => {
    const res = await call('POST', '/mileage', {
      tripDate: '2026-10-30', startAddress: 'Shop', endAddress: 'Job site', distanceMiles: '10',
      purpose: 'business', notes: '',
    });
    expect(res.status).toBe(200);
    expect(mileageService.getIrsRate).toHaveBeenCalledWith('2026-10-30');
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toMatchObject({
      trip_date: '2026-10-30', start_address: 'Shop', end_address: 'Job site',
      distance_miles: 10, irs_rate: 0.7, deduction_amount: 7, source: 'manual',
    });
  });

  test.each([
    ['negative', { tripDate: '2026-10-30', distanceMiles: -10 }],
    ['zero', { tripDate: '2026-10-30', distanceMiles: 0 }],
    ['zero as text', { tripDate: '2026-10-30', distanceMiles: '0' }],
    ['blank', { tripDate: '2026-10-30', distanceMiles: '' }],
    ['not a number', { tripDate: '2026-10-30', distanceMiles: 'ten' }],
    ['not a number type', { tripDate: '2026-10-30', distanceMiles: true }],
    ['impossible date', { tripDate: '2026-02-30', distanceMiles: 10 }],
    ['the old snake_case body', { trip_date: '2026-10-30', distance_miles: '10' }],
  ])('%s is a 400 with no rate lookup and no insert', async (_name, body) => {
    const res = await call('POST', '/mileage', body);
    expect(res.status).toBe(400);
    expect(mileageService.getIrsRate).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});

describe('POST /admin/tax/mileage/sync-bouncie', () => {
  test('no dates (the Sync from Bouncie button) syncs the last 7 Eastern days through today', async () => {
    // 00:30 UTC on Nov 1 is still Oct 31 in Eastern time
    atInstant('2026-11-01T00:30:00Z');
    const res = await call('POST', '/mileage/sync-bouncie');
    expect(res.status).toBe(200);
    expect(BouncieService.syncMileage).toHaveBeenCalledWith('2026-10-25', '2026-10-31');
    expect(res.body).toMatchObject({ startDate: '2026-10-25', endDate: '2026-10-31', tripsImported: 2 });
  });

  test('explicit dates pass through', async () => {
    const res = await call('POST', '/mileage/sync-bouncie', { startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(res.status).toBe(200);
    expect(BouncieService.syncMileage).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
  });

  test.each([
    ['one date only', { startDate: '2026-09-01' }],
    ['an impossible date', { startDate: '2026-09-01', endDate: '2026-09-31' }],
    ['an end before the start', { startDate: '2026-09-30', endDate: '2026-09-01' }],
  ])('%s is a 400 before any Bouncie call', async (_name, body) => {
    const res = await call('POST', '/mileage/sync-bouncie', body);
    expect(res.status).toBe(400);
    expect(BouncieService.syncMileage).not.toHaveBeenCalled();
  });
});

describe('GET /admin/tax/mileage/stats', () => {
  const tripDateBounds = () => whereCalls
    .filter(([table, column]) => table === 'mileage_log' && column === 'trip_date')
    .map(([, , op, value]) => `${op} ${value}`);

  test('without a year it reads the Eastern year, not the UTC one', async () => {
    // 00:30 UTC on Jan 1 2027 is still Dec 31 2026 in Eastern time
    atInstant('2027-01-01T00:30:00Z');
    const res = await call('GET', '/mileage/stats');
    expect(res.status).toBe(200);
    expect(res.body.year).toBe('2026');
    expect(new Set(tripDateBounds())).toEqual(new Set(['>= 2026-01-01', '<= 2026-12-31']));
  });

  test('an explicit year is honored; a malformed one is a 400', async () => {
    expect((await call('GET', '/mileage/stats?year=2025')).body.year).toBe('2025');
    expect(new Set(tripDateBounds())).toEqual(new Set(['>= 2025-01-01', '<= 2025-12-31']));
    expect((await call('GET', '/mileage/stats?year=20x5')).status).toBe(400);
  });
});
