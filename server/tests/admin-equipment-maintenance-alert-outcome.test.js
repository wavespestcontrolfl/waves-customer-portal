/**
 * routes/admin-equipment-maintenance.js PUT /alerts/:id — resolving a
 * truck-check alert (tool_missing / tool_damaged) with an outcome: Lost and
 * Retired set the item's status, every outcome closes the truck's bell when
 * no tool alert on it is open, and the outcome is admin-only. Other alerts
 * keep the plain resolve. Handlers are invoked directly over a small db fake.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/equipment-maintenance', () => ({}));
jest.mock('../services/truck-kit', () => ({
  TOOL_ALERT_TYPES: ['tool_missing', 'tool_damaged'],
  closeTruckBellIfClear: jest.fn(async () => true),
  lockTruck: jest.fn(async () => ({ rows: [] })),
}));
jest.mock('../models/db', () => {
  const state = { alerts: {}, equipment: {}, updates: [] };
  const chain = (table) => {
    const c = { table, id: null, patch: null };
    c.where = (...args) => { c.id = args.length === 2 ? args[1] : args[0]?.id; return c; };
    c.whereIn = (col, vals) => { c.statuses = vals; return c; };
    c.first = async () => (table === 'maintenance_alerts' ? state.alerts[c.id] : state.equipment[c.id]) || null;
    c.update = (patch) => { c.patch = patch; state.updates.push([table, c.id, patch]); return c; };
    c.returning = async () => {
      const row = state.alerts[c.id];
      if (!row) return [];
      if (c.statuses && !c.statuses.includes(row.status)) return [];
      Object.assign(row, c.patch);
      return [row];
    };
    c.then = (resolve, reject) => {
      if (c.patch && table === 'equipment' && state.equipment[c.id]) Object.assign(state.equipment[c.id], c.patch);
      return Promise.resolve(1).then(resolve, reject);
    };
    return c;
  };
  const db = jest.fn(chain);
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.fn = { now: () => 'NOW()' };
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const truckKit = require('../services/truck-kit');
const router = require('../routes/admin-equipment-maintenance');

const TOOL = 'e-tool';
const TRUCK = 'e-truck';

function layerFor(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

async function put(id, body, techRole = 'admin') {
  const layer = layerFor('put', '/alerts/:id');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextErr;
  await handler({ params: { id }, body, techRole }, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.__state.alerts = {
    'a-missing': { id: 'a-missing', equipment_id: TOOL, alert_type: 'tool_missing', status: 'new' },
    'a-due': { id: 'a-due', equipment_id: TOOL, alert_type: 'maintenance_due', status: 'new' },
  };
  db.__state.equipment = { [TOOL]: { id: TOOL, status: 'active', assigned_vehicle_id: TRUCK } };
  db.__state.updates = [];
});

test.each([['post', '/'], ['put', '/:id([0-9a-fA-F-]{36})'], ['delete', '/:id([0-9a-fA-F-]{36})']])('%s %s (asset writer that spreads the body) carries requireAdmin', (method, path) => {
  const { requireAdmin } = require('../middleware/admin-auth');
  const layer = layerFor(method, path);
  expect(layer).toBeTruthy();
  expect(layer.route.stack.some((l) => l.handle === requireAdmin)).toBe(true);
});

test('Lost resolves the alert, marks the item lost and closes the truck bell', async () => {
  const res = await put('a-missing', { status: 'resolved', outcome: 'lost' });
  expect(res.statusCode).toBe(200);
  expect(res.body.alert).toEqual(expect.objectContaining({ status: 'resolved', resolved_by: 'admin' }));
  expect(db.__state.equipment[TOOL].status).toBe('lost');
  // All three writes ride one transaction, under the truck's lock, and the bell close runs on it.
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(truckKit.lockTruck).toHaveBeenCalledWith(db, TRUCK);
  expect(truckKit.closeTruckBellIfClear).toHaveBeenCalledWith(TRUCK, expect.any(Date), db);
  const lockAt = truckKit.lockTruck.mock.invocationCallOrder[0];
  const updateAt = db.mock.invocationCallOrder.find((n) => n > lockAt);
  expect(updateAt).toBeGreaterThan(lockAt);
});

test('a stale Lost on an alert the truck check already closed is refused and marks nothing', async () => {
  db.__state.alerts['a-missing'].status = 'resolved';
  const res = await put('a-missing', { status: 'resolved', outcome: 'lost' });
  expect(res.statusCode).toBe(409);
  expect(db.__state.equipment[TOOL].status).toBe('active');
  expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
  // A plain maintenance alert keeps its idempotent resolve.
  db.__state.alerts['a-due'].status = 'resolved';
  expect((await put('a-due', { status: 'resolved' })).statusCode).toBe(200);
});

test('a tool alert never resolves without an outcome', async () => {
  const res = await put('a-missing', { status: 'resolved' });
  expect(res.statusCode).toBe(400);
  expect(res.body.error).toMatch(/outcome/);
  expect(db.__state.alerts['a-missing'].status).toBe('new');
  expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
  // Acknowledging it (not resolving) still needs no outcome.
  expect((await put('a-missing', { status: 'acknowledged' })).statusCode).toBe(200);
});

test('Found resolves the alert, leaves the item alone and still checks the bell', async () => {
  await put('a-missing', { status: 'resolved', outcome: 'found' });
  expect(db.__state.equipment[TOOL].status).toBe('active');
  expect(db.__state.updates.some(([table]) => table === 'equipment')).toBe(false);
  expect(truckKit.closeTruckBellIfClear).toHaveBeenCalledWith(TRUCK, expect.any(Date), db);
});

test('an outcome is admin-only, tool-alert-only, from the fixed list, and resolves', async () => {
  expect((await put('a-missing', { status: 'resolved', outcome: 'lost' }, 'technician')).statusCode).toBe(403);
  expect((await put('a-due', { status: 'resolved', outcome: 'lost' })).statusCode).toBe(400);
  expect((await put('a-missing', { status: 'resolved', outcome: 'vanished' })).statusCode).toBe(400);
  expect((await put('a-missing', { status: 'acknowledged', outcome: 'lost' })).statusCode).toBe(400);
  expect(db.__state.alerts['a-missing'].status).toBe('new');
  expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
});

test('a technician cannot resolve a truck-check alert at all, with or without an outcome', async () => {
  expect((await put('a-missing', { status: 'resolved' }, 'technician')).statusCode).toBe(403);
  expect(db.__state.alerts['a-missing'].status).toBe('new');
  expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
  // Other alerts keep today's reach (closed at the staff default-deny flip).
  expect((await put('a-due', { status: 'resolved' }, 'technician')).statusCode).toBe(200);
});

test('a plain resolve of a maintenance alert is unchanged: no item write, no bell check', async () => {
  const res = await put('a-due', { status: 'resolved' });
  expect(res.statusCode).toBe(200);
  expect(db.__state.updates.some(([table]) => table === 'equipment')).toBe(false);
  expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
  expect((await put('nope', { status: 'resolved' })).statusCode).toBe(404);
});
