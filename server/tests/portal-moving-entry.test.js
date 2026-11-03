/**
 * GET / POST /api/property/moving — the customer app's "Take WaveGuard with
 * you" (moving PR 2a, GATE_MOVING_PORTAL, needs GATE_MOVING_FLOW).
 *
 *  - Dark: GET answers { enabled: false } and POST answers 404 without opening
 *    a move.
 *  - On: POST opens (or reuses) the SIGNED-IN customer's move and answers its
 *    moving page path; nothing else is read from the request.
 *  - A failure answers 500 with a plain sentence and logs no bindings.
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('no db read expected'); }));
jest.mock('../services/customer-moves', () => ({
  openMoveForCustomer: jest.fn(async (customerId) => ({ id: 'move-1', customer_id: customerId, token: 'ab'.repeat(24), status: 'open' })),
}));

const Moves = require('../services/customer-moves');
const logger = require('../services/logger');
const propertyRouter = require('../routes/property');

function routeHandler(method, path) {
  const layer = propertyRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(method, { customerId = 'cust-1', body = {} } = {}) {
  const req = { customerId, body, query: {}, params: {} };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
  };
  await routeHandler(method, '/moving')(req, res, (err) => { if (err) throw err; });
  return { statusCode, body: jsonBody };
}

const OLD = {};
beforeAll(() => { for (const k of ['GATE_MOVING_FLOW', 'GATE_MOVING_PORTAL']) OLD[k] = process.env[k]; });
afterEach(() => {
  for (const [k, v] of Object.entries(OLD)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  jest.clearAllMocks();
});

test('dark: the app shows no button and the open route is a 404', async () => {
  process.env.GATE_MOVING_FLOW = 'true';
  delete process.env.GATE_MOVING_PORTAL;
  expect(await invoke('get')).toEqual({ statusCode: 200, body: { enabled: false } });
  expect(await invoke('post')).toEqual({ statusCode: 404, body: { error: 'Not found' } });
  // GATE_MOVING_PORTAL alone is not enough: the moving flow itself must be on.
  process.env.GATE_MOVING_PORTAL = 'true';
  delete process.env.GATE_MOVING_FLOW;
  expect((await invoke('get')).body).toEqual({ enabled: false });
  expect((await invoke('post')).statusCode).toBe(404);
  expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
});

test('on: the button opens the signed-in customer\'s own moving page', async () => {
  process.env.GATE_MOVING_FLOW = 'true';
  process.env.GATE_MOVING_PORTAL = 'true';
  expect((await invoke('get')).body).toEqual({ enabled: true });
  // A body naming another customer is ignored: the move is always the signed-in customer's.
  const res = await invoke('post', { customerId: 'cust-1', body: { customerId: 'cust-2' } });
  expect(res).toEqual({ statusCode: 200, body: { path: `/moving/${'ab'.repeat(24)}` } });
  expect(Moves.openMoveForCustomer).toHaveBeenCalledWith('cust-1');
});

test('a failure answers a plain 500 and logs the error code only', async () => {
  process.env.GATE_MOVING_FLOW = 'true';
  process.env.GATE_MOVING_PORTAL = 'true';
  Moves.openMoveForCustomer.mockRejectedValueOnce(Object.assign(new Error('insert into customer_moves ... 12 Secret Street'), { code: '23503' }));
  const res = await invoke('post');
  expect(res).toEqual({ statusCode: 500, body: { error: 'We could not open the moving page. Please try again, or call us.' } });
  expect(logger.error.mock.calls[0][0]).toContain('(23503)');
  expect(logger.error.mock.calls[0][0]).not.toContain('Secret Street');
});
