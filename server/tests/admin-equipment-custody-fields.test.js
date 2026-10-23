/**
 * routes/admin-equipment.js — the custody columns the Assets dialog writes
 * (docs/tool-inventory-tracker-scope.md, PR 0): asset_tag, location,
 * assigned_vehicle_id and condition_rating. Before this slice only seed
 * migrations could set them. Handlers are invoked directly (same pattern as
 * tests/admin-tech-out-routes.test.js); db is a small fake recording the
 * insert/update row and answering the vehicle lookup.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/equipment-maintenance', () => ({}));
jest.mock('../models/db', () => {
  const state = { vehicles: {}, rows: {}, riders: {}, inserted: null, updated: null, fail: null, listRows: [], chains: [] };
  const chain = (table) => {
    const c = { table, calls: [], cond: null };
    const rec = (name) => jest.fn((...args) => { c.calls.push([name, ...args]); return c; });
    for (const m of ['leftJoin', 'select', 'orderBy', 'whereNull']) c[m] = rec(m);
    c.where = jest.fn((...args) => {
      c.calls.push(['where', ...args]);
      if (args.length === 1 && typeof args[0] === 'object') c.cond = { ...(c.cond || {}), ...args[0] };
      return c;
    });
    c.first = jest.fn(async (...args) => {
      c.calls.push(['first', ...args]);
      if (table === 'equipment' && c.cond && c.cond.category === 'vehicle') return state.vehicles[c.cond.id] || null;
      if (table === 'equipment' && c.cond && c.cond.id && c.cond.category === undefined) return state.rows[c.cond.id] || null;
      if (table === 'equipment' && c.cond && c.cond.assigned_vehicle_id) return state.riders[c.cond.assigned_vehicle_id] || null;
      return null;
    });
    c.insert = jest.fn((row) => { c.calls.push(['insert', row]); state.inserted = row; return c; });
    c.update = jest.fn((row) => { c.calls.push(['update', row]); state.updated = row; return c; });
    c.returning = jest.fn(async () => {
      if (state.fail) { const err = state.fail; state.fail = null; throw err; }
      const row = state.inserted || state.updated;
      return row ? [{ id: 'row-1', ...row }] : [];
    });
    c.then = (resolve, reject) => Promise.resolve(state.listRows).then(resolve, reject);
    state.chains.push(c);
    return c;
  };
  const db = jest.fn(chain);
  db.raw = jest.fn((sql) => ({ sql }));
  db.fn = { now: () => 'NOW()' };
  db.__state = state;
  return db;
});

const db = require('../models/db');
const router = require('../routes/admin-equipment');
const { requireAdmin } = require('../middleware/admin-auth');

const VEHICLE = '11111111-2222-4333-8444-555555555555';
const OTHER = '22222222-2222-4333-8444-555555555555';
const TOOL = '33333333-2222-4333-8444-555555555555';

function layerFor(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

async function run(method, path, { params = {}, query = {}, body = {} } = {}) {
  const layer = layerFor(method, path);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nextErr;
  await handler({ params, query, body, techRole: 'admin' }, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  const s = db.__state;
  s.vehicles = { [VEHICLE]: { id: VEHICLE } };
  s.rows = { [TOOL]: { id: TOOL, category: 'tool' }, [OTHER]: { id: OTHER, category: 'vehicle' } };
  s.riders = { [VEHICLE]: { id: TOOL } };
  s.inserted = null;
  s.updated = null;
  s.fail = null;
  s.listRows = [];
  s.chains = [];
});

describe('asset create and edit are office-only', () => {
  // The router admits technicians (requireTechOrAdmin) for its reads and the
  // field writes; the custody columns must not depend on GATE_STAFF_DEFAULT_DENY.
  test.each([['post', '/equipment'], ['put', '/equipment/:id']])('%s %s carries requireAdmin', (method, path) => {
    const layer = layerFor(method, path);
    expect(layer.route.stack.some((l) => l.handle === requireAdmin)).toBe(true);
  });

  test('requireAdmin refuses a technician token', () => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    const next = jest.fn();
    requireAdmin({ techRole: 'technician' }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('a vehicle is never cargo', () => {
  test('creating a vehicle with a truck is refused', async () => {
    const res = await run('post', '/equipment', { body: { name: 'Synthetic van', category: 'vehicle', assigned_vehicle_id: VEHICLE } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/vehicle cannot be assigned/);
    expect(db.__state.inserted).toBeNull();
  });

  test('assigning a truck to a stored vehicle row is refused', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: OTHER }, body: { assigned_vehicle_id: VEHICLE } });
    expect(res.statusCode).toBe(400);
    expect(db.__state.updated).toBeNull();
  });

  test('recategorizing a tool as a vehicle drops the truck it rode on', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { category: 'vehicle' } });
    expect(res.statusCode).toBe(200);
    expect(db.__state.updated).toEqual(expect.objectContaining({ category: 'vehicle', assigned_vehicle_id: null }));
  });

  test('a truck with riders cannot stop being a vehicle', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: VEHICLE }, body: { category: 'other' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/still ride/);
    expect(db.__state.updated).toBeNull();
  });

  test('an empty truck may be recategorized', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: OTHER }, body: { category: 'other' } });
    expect(res.statusCode).toBe(200);
    expect(db.__state.updated).toEqual(expect.objectContaining({ category: 'other' }));
  });

  test('a tool still rides on a truck', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: VEHICLE } });
    expect(res.statusCode).toBe(200);
    expect(db.__state.updated).toEqual(expect.objectContaining({ assigned_vehicle_id: VEHICLE }));
  });
});

describe('POST /equipment custody columns', () => {
  test('writes the tag, place, truck and condition when the truck is a vehicle', async () => {
    const res = await run('post', '/equipment', { body: {
      name: 'Synthetic moisture meter', category: 'tool',
      asset_tag: '  T-001 ', location: 'van', assigned_vehicle_id: VEHICLE, condition_rating: '9',
    } });
    expect(res.statusCode).toBe(201);
    expect(db.__state.inserted).toEqual(expect.objectContaining({
      asset_tag: 'T-001', location: 'van', assigned_vehicle_id: VEHICLE, condition_rating: 9,
    }));
  });

  test('a body without custody keys leaves the table defaults alone', async () => {
    const res = await run('post', '/equipment', { body: { name: 'Synthetic duster', category: 'tool' } });
    expect(res.statusCode).toBe(201);
    for (const key of ['asset_tag', 'location', 'assigned_vehicle_id', 'condition_rating']) {
      expect(key in db.__state.inserted).toBe(false);
    }
  });

  test('refuses a truck that is not a vehicle row, writing nothing', async () => {
    const res = await run('post', '/equipment', { body: { name: 'Synthetic duster', assigned_vehicle_id: OTHER } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'assigned_vehicle_id must be a vehicle' });
    expect(db.__state.inserted).toBeNull();
  });

  test('refuses a condition outside 1 to 10 or not a whole number', async () => {
    for (const bad of [0, 11, 'abc', 7.5]) {
      const res = await run('post', '/equipment', { body: { name: 'Synthetic duster', condition_rating: bad } });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/condition_rating/);
    }
    expect(db.__state.inserted).toBeNull();
  });

  test('a duplicate asset tag answers 409, not a 500', async () => {
    db.__state.fail = Object.assign(new Error('duplicate key value violates unique constraint "equipment_asset_tag_unique"'), {
      code: '23505', constraint: 'equipment_asset_tag_unique',
    });
    const res = await run('post', '/equipment', { body: { name: 'Synthetic duster', asset_tag: 'T-001' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/asset tag/i);
  });
});

describe('PUT /equipment/:id custody columns', () => {
  test('writes the custody columns, clearing blanks to null', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: {
      asset_tag: '', location: 'storage', assigned_vehicle_id: VEHICLE, condition_rating: '',
    } });
    expect(res.statusCode).toBe(200);
    expect(db.__state.updated).toEqual(expect.objectContaining({
      asset_tag: null, location: 'storage', assigned_vehicle_id: VEHICLE, condition_rating: null,
    }));
  });

  test('a row can never be its own truck', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: VEHICLE }, body: { assigned_vehicle_id: VEHICLE } });
    expect(res.statusCode).toBe(400);
    expect(db.__state.updated).toBeNull();
  });

  test('keys the body does not carry are left alone', async () => {
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(db.__state.updated).sort()).toEqual(['name', 'updated_at']);
  });
});

describe('GET /equipment', () => {
  test('joins the truck each row rides on and filters one truck or none', async () => {
    await run('get', '/equipment', { query: { assigned_vehicle_id: VEHICLE } });
    let chain = db.__state.chains[0];
    expect(chain.calls).toEqual(expect.arrayContaining([
      ['leftJoin', 'equipment as vehicle', 'equipment.assigned_vehicle_id', 'vehicle.id'],
      ['where', 'equipment.assigned_vehicle_id', VEHICLE],
    ]));
    expect(chain.calls.find((c) => c[0] === 'select')).toEqual(expect.arrayContaining([
      'vehicle.name as assigned_vehicle_name', 'vehicle.asset_tag as assigned_vehicle_tag',
    ]));

    db.__state.chains = [];
    await run('get', '/equipment', { query: { assigned_vehicle_id: 'none' } });
    chain = db.__state.chains[0];
    expect(chain.calls).toEqual(expect.arrayContaining([['whereNull', 'equipment.assigned_vehicle_id']]));
    expect(chain.calls.some((c) => c[0] === 'where' && c[1] === 'equipment.assigned_vehicle_id')).toBe(false);
  });
});
