// Misting system records routes (GATE_MOSQUITO_MISTING): auth, the gate, uuid params, error mapping and the happy
// paths, with the service mocked. The rules themselves are proven on a real PostgreSQL in
// misting-records-service-postgres.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const CAL = '22222222-2222-4222-8222-222222222222';
const REFILL = '33333333-3333-4333-8333-333333333333';
const TECH = '44444444-4444-4444-8444-444444444444';

const mockDb = jest.fn(() => { throw new Error('the database was touched'); });
jest.mock('../models/db', () => (...a) => mockDb(...a));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockSvc = {
  listCustomerRecords: jest.fn(),
  createCalibration: jest.fn(),
  createRefill: jest.fn(),
  voidCalibration: jest.fn(),
  voidRefill: jest.fn(),
};
jest.mock('../services/misting-records', () => ({
  recordsEnabled: () => require('../config/feature-gates').mosquitoMistingLive(),
  isUuid: (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '')),
  listCustomerRecords: (...a) => mockSvc.listCustomerRecords(...a),
  createCalibration: (...a) => mockSvc.createCalibration(...a),
  createRefill: (...a) => mockSvc.createRefill(...a),
  voidCalibration: (...a) => mockSvc.voidCalibration(...a),
  voidRefill: (...a) => mockSvc.voidRefill(...a),
}));

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.techRole = req.headers['x-test-role'] || 'technician';
    req.technicianId = '44444444-4444-4444-8444-444444444444';
    next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const router = require('../routes/admin-misting-records');

const savedGate = process.env.GATE_MOSQUITO_MISTING;
let server;
let baseUrl;
beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/misting-records', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  process.env.GATE_MOSQUITO_MISTING = 'true';
  Object.values(mockSvc).forEach((fn) => fn.mockReset());
  mockDb.mockClear();
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = savedGate;
});

async function call(method, path, { role = 'admin', body } = {}) {
  const res = await fetch(`${baseUrl}/api/admin/misting-records${path}`, {
    method,
    headers: { 'x-test-role': role, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const opError = (statusCode, code, message) => Object.assign(new Error(message), { isOperational: true, statusCode, code });

const ROUTES = [
  ['GET', `/customers/${CUSTOMER}/records`, undefined],
  ['POST', `/customers/${CUSTOMER}/calibrations`, {}],
  ['POST', `/customers/${CUSTOMER}/refills`, {}],
  ['POST', `/calibrations/${CAL}/void`, { reason: 'typo in nozzle count' }],
  ['POST', `/refills/${REFILL}/void`, { reason: 'wrong day' }],
];

describe('gate and auth', () => {
  test.each(ROUTES)('gate off: %s %s answers 404 Not enabled and touches nothing', async (method, path, body) => {
    delete process.env.GATE_MOSQUITO_MISTING;
    const res = await call(method, path, { body });
    expect(res).toEqual({ status: 404, json: { error: 'Not enabled' } });
    Object.values(mockSvc).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(mockDb).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('a technician gets 403 on %s %s', async (method, path, body) => {
    const res = await call(method, path, { role: 'technician', body });
    expect(res.status).toBe(403);
    Object.values(mockSvc).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  test.each([
    ['GET', '/customers/nope/records', undefined],
    ['POST', '/customers/nope/calibrations', {}],
    ['POST', '/customers/nope/refills', {}],
    ['POST', '/calibrations/nope/void', { reason: 'abc' }],
    ['POST', '/refills/nope/void', { reason: 'abc' }],
  ])('a non-uuid id on %s %s is a 404', async (method, path, body) => {
    expect((await call(method, path, { body })).status).toBe(404);
    Object.values(mockSvc).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
});

describe('happy paths', () => {
  test('GET returns the customer\'s records', async () => {
    const payload = { properties: [], calibrations: [{ id: CAL }], refills: [] };
    mockSvc.listCustomerRecords.mockResolvedValue(payload);
    const res = await call('GET', `/customers/${CUSTOMER}/records`);
    expect(res).toEqual({ status: 200, json: payload });
    expect(mockSvc.listCustomerRecords).toHaveBeenCalledWith(CUSTOMER);
  });

  test('POST calibrations is 201, passes the body and the signed-in staff member', async () => {
    mockSvc.createCalibration.mockResolvedValue({ id: CAL, dailyOutputFlOz: 99, labelDailyCapFlOz: 456 });
    const body = { vendor: 'Pynamite' };
    const res = await call('POST', `/customers/${CUSTOMER}/calibrations`, { body });
    expect(res).toEqual({ status: 201, json: { calibration: { id: CAL, dailyOutputFlOz: 99, labelDailyCapFlOz: 456 } } });
    expect(mockSvc.createCalibration).toHaveBeenCalledWith({ customerId: CUSTOMER, input: body, actorId: TECH });
  });

  test('POST refills is 201', async () => {
    mockSvc.createRefill.mockResolvedValue({ id: REFILL });
    const body = { calibrationId: CAL };
    const res = await call('POST', `/customers/${CUSTOMER}/refills`, { body });
    expect(res).toEqual({ status: 201, json: { refill: { id: REFILL } } });
    expect(mockSvc.createRefill).toHaveBeenCalledWith({ customerId: CUSTOMER, input: body, actorId: TECH });
  });

  test('void routes pass the reason and answer 200', async () => {
    mockSvc.voidCalibration.mockResolvedValue({ id: CAL, voidReason: 'typo in nozzle count' });
    mockSvc.voidRefill.mockResolvedValue({ id: REFILL, voidReason: 'wrong day' });
    expect(await call('POST', `/calibrations/${CAL}/void`, { body: { reason: 'typo in nozzle count' } }))
      .toEqual({ status: 200, json: { calibration: { id: CAL, voidReason: 'typo in nozzle count' } } });
    expect(await call('POST', `/refills/${REFILL}/void`, { body: { reason: 'wrong day' } }))
      .toEqual({ status: 200, json: { refill: { id: REFILL, voidReason: 'wrong day' } } });
    expect(mockSvc.voidCalibration).toHaveBeenCalledWith({ id: CAL, reason: 'typo in nozzle count', actorId: TECH });
    expect(mockSvc.voidRefill).toHaveBeenCalledWith({ id: REFILL, reason: 'wrong day', actorId: TECH });
  });
});

describe('error mapping', () => {
  test.each([
    [400, 'MISTING_BAD_INPUT', 'Tank size must be 1 to 300 gallons.'],
    [409, 'MISTING_CALIBRATION_NOT_CURRENT', 'This calibration has been replaced.'],
    [422, 'MISTING_OVER_LABEL', 'This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles.'],
    [422, 'MISTING_CHECKS_INCOMPLETE', 'Check every box before saving. Not checked: Lock the cabinet.'],
    [422, 'MISTING_LABEL_LIMIT_MISMATCH', 'The Sector label allows at most 9.5 fl oz per 1,000 cu ft a day.'],
  ])('a calibration save that fails with %i %s returns that status, code and message', async (status, code, message) => {
    mockSvc.createCalibration.mockRejectedValue(opError(status, code, message));
    expect(await call('POST', `/customers/${CUSTOMER}/calibrations`, { body: {} })).toEqual({ status, json: { error: message, code } });
  });

  test.each([
    [409, 'MISTING_CALIBRATION_NOT_CURRENT'],
    [422, 'MISTING_PRODUCT_CHANGED'],
    [422, 'MISTING_MIX_CHANGED'],
  ])('a refill save that fails with %i %s maps through', async (status, code) => {
    mockSvc.createRefill.mockRejectedValue(opError(status, code, 'Plain words'));
    expect(await call('POST', `/customers/${CUSTOMER}/refills`, { body: {} })).toEqual({ status, json: { error: 'Plain words', code } });
  });

  test('void conflicts map through', async () => {
    mockSvc.voidCalibration.mockRejectedValue(opError(409, 'MISTING_CALIBRATION_HAS_REFILLS', 'Void its refills first, or record a new calibration instead.'));
    mockSvc.voidRefill.mockRejectedValue(opError(409, 'MISTING_ALREADY_VOIDED', 'This record is already voided.'));
    expect((await call('POST', `/calibrations/${CAL}/void`, { body: { reason: 'abc' } })).status).toBe(409);
    expect((await call('POST', `/refills/${REFILL}/void`, { body: { reason: 'abc' } })).json.code).toBe('MISTING_ALREADY_VOIDED');
  });

  test('a missing customer on read is a 404 from the service', async () => {
    mockSvc.listCustomerRecords.mockRejectedValue(opError(404, 'MISTING_CUSTOMER_NOT_FOUND', 'Customer not found.'));
    expect((await call('GET', `/customers/${CUSTOMER}/records`)).status).toBe(404);
  });

  test('an unexpected error is a 500 and does not leak through the operational path', async () => {
    mockSvc.createRefill.mockRejectedValue(new Error('connection reset'));
    const res = await call('POST', `/customers/${CUSTOMER}/refills`, { body: {} });
    expect(res.status).toBe(500);
    expect(res.json.code).toBeUndefined();
  });
});
