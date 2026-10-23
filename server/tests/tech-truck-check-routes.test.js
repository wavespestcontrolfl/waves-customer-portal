/**
 * routes/tech-truck-check.js — GATE_TRUCK_KIT tech surface. services/truck-kit.js
 * is mocked; these pin the route layer: the gate check on both handlers, the
 * login-derived technician, and the error-code to HTTP-status mapping.
 * Handlers are invoked directly (tests/admin-tech-out-routes.test.js pattern).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/truck-kit', () => ({
  truckKitEnabled: jest.fn(),
  truckKitStatus: jest.fn(),
  recordTruckCheck: jest.fn(),
}));

const truckKit = require('../services/truck-kit');
const router = require('../routes/tech-truck-check');

function layerFor(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

async function run(method, { body = {} } = {}) {
  const layer = layerFor(method, '/');
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} /`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
  let nextErr;
  await handler({ body, technicianId: 'tech-1', techRole: 'technician' }, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}

beforeEach(() => jest.clearAllMocks());

test('gate off answers 404 { enabled: false } on both routes, with no service call', async () => {
  truckKit.truckKitEnabled.mockReturnValue(false);
  expect((await run('get')).statusCode).toBe(404);
  expect((await run('get')).body).toEqual({ enabled: false });
  expect((await run('post', { body: { results: [] } })).statusCode).toBe(404);
  expect(truckKit.truckKitStatus).not.toHaveBeenCalled();
  expect(truckKit.recordTruckCheck).not.toHaveBeenCalled();
});

test('GET reads the status of the signed-in technician and never caches it', async () => {
  truckKit.truckKitEnabled.mockReturnValue(true);
  truckKit.truckKitStatus.mockResolvedValue({ enabled: true, truck: { id: 'v1' }, kit: [], lastCheck: null, due: false });
  const res = await run('get');
  expect(res.body).toEqual(expect.objectContaining({ enabled: true, truck: { id: 'v1' } }));
  expect(truckKit.truckKitStatus).toHaveBeenCalledWith('tech-1');
  expect(res.headers['Cache-Control']).toBe('private, no-store');
});

test('POST records a check for the signed-in technician and answers 201', async () => {
  truckKit.truckKitEnabled.mockReturnValue(true);
  truckKit.recordTruckCheck.mockResolvedValue({ check: { id: 'k1' } });
  const results = [{ equipmentId: 'e1', state: 'present' }];
  const res = await run('post', { body: { results } });
  expect(res.statusCode).toBe(201);
  expect(res.body).toEqual({ check: { id: 'k1' } });
  expect(truckKit.recordTruckCheck).toHaveBeenCalledWith({ technicianId: 'tech-1', results });
});

test('POST maps the service errors: no truck 404, bad results 400, changed kit 409 with the kit', async () => {
  truckKit.truckKitEnabled.mockReturnValue(true);
  const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
  truckKit.recordTruckCheck.mockRejectedValueOnce(fail('no_truck'));
  expect((await run('post')).statusCode).toBe(404);
  truckKit.recordTruckCheck.mockRejectedValueOnce(fail('invalid_results'));
  expect((await run('post')).statusCode).toBe(400);
  truckKit.recordTruckCheck.mockRejectedValueOnce(fail('kit_changed', { kit: [{ id: 'e2' }] }));
  const res = await run('post');
  expect(res.statusCode).toBe(409);
  expect(res.body).toEqual({ error: 'kit_changed', code: 'kit_changed', kit: [{ id: 'e2' }] });
  truckKit.recordTruckCheck.mockRejectedValueOnce(fail('ambiguous_truck'));
  expect((await run('post')).statusCode).toBe(409);
  truckKit.truckKitStatus.mockRejectedValueOnce(fail('ambiguous_truck'));
  const two = await run('get');
  expect(two.statusCode).toBe(409);
  expect(two.body).toEqual({ error: 'ambiguous_truck', code: 'ambiguous_truck' });
  truckKit.recordTruckCheck.mockRejectedValueOnce(new Error('db down'));
  await expect(run('post')).rejects.toThrow('db down');
});
