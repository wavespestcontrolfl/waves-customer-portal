/**
 * GET /admin/dispatch/:serviceId/reservice-asks (re-service asks, dark behind
 * GATE_RESERVICE_ASKS).
 *
 *  - Gate off answers 404 {enabled:false} without touching the database.
 *  - A technician only reads their own visit; admins read any.
 *  - Gate on returns the gatherer's body under {enabled:true}; a visit that is
 *    not a re-service is a 409, a missing visit is 404.
 *  - The route is registered behind the router-level tech-or-admin auth.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'select', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.first = async () => null;
  chain.then = (resolve) => Promise.resolve([]).then(resolve);
  chain.catch = () => chain;
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : chain);
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/reservice-asks', () => ({ gatherReserviceAsks: jest.fn() }));

const router = require('../routes/admin-dispatch');
const { gatherReserviceAsks } = require('../services/reservice-asks');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(method, routePath, { params = {}, body, actor = { techRole: 'admin', technicianId: 'admin-1' } } = {}) {
  const layer = routeLayer(method, routePath);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, query: {}, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const ASKS = '/:serviceId/reservice-asks';
const params = { serviceId: 'visit-1' };
const BODY = {
  ok: true,
  lane: 'pest',
  window: { from: '2026-10-18T14:00:00.000Z', to: '2026-11-02T15:00:00.000Z' },
  items: [{ id: 'booking:visit-1', source: 'request_form', text: 'Ants in the kitchen', quoted: true }],
};

// A scripted db: scheduled_services -> the owning row (assertRecapOwnership).
const dbWithOwner = (technician_id, calls = []) => (table) => {
  calls.push(table);
  const chain = {};
  for (const m of ['where', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id, status: 'confirmed', scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'Pest Control Re-Service' } : null);
  return chain;
};

describe('GET reservice-asks', () => {
  const savedGate = process.env.GATE_RESERVICE_ASKS;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_RESERVICE_ASKS; else process.env.GATE_RESERVICE_ASKS = savedGate;
    mockDbCurrent = null;
    gatherReserviceAsks.mockReset();
  });

  test('is registered on the router after the router-level auth', () => {
    const layer = routeLayer('get', ASKS);
    expect(layer).toBeTruthy();
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p answers 404 {enabled:false} and reads nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_RESERVICE_ASKS; else process.env.GATE_RESERVICE_ASKS = value;
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    const res = await invoke('get', ASKS, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
  });

  test('gate on: the owning technician gets the asks under {enabled:true}, without ok', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    gatherReserviceAsks.mockResolvedValue(BODY);
    const res = await invoke('get', ASKS, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, lane: 'pest', window: BODY.window, items: BODY.items });
    expect(gatherReserviceAsks).toHaveBeenCalledWith('visit-1');
  });

  test("gate on: a technician cannot read another technician's visit", async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await invoke('get', ASKS, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(403);
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
  });

  test('gate on: an admin reads any visit', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    gatherReserviceAsks.mockResolvedValue({ ...BODY, items: [] });
    const res = await invoke('get', ASKS, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('gate on: a visit that is not a re-service is refused with a 409', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    gatherReserviceAsks.mockResolvedValue({ ok: false, reason: 'not_reservice' });
    const res = await invoke('get', ASKS, { params });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not_reservice', code: 'not_reservice' });
  });

  test('gate on: a visit that disappears is 404', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    gatherReserviceAsks.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await invoke('get', ASKS, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', code: 'not_found' });
  });

  test('gate on: a read failure goes to the error handler', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    gatherReserviceAsks.mockRejectedValue(new Error('db down'));
    await expect(invoke('get', ASKS, { params })).rejects.toThrow('db down');
  });
});
