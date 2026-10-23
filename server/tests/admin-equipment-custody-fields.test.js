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
  const state = { vehicles: {}, rows: {}, riders: {}, trucksOf: {}, inserted: null, updated: null, fail: null, listRows: [], chains: [] };
  const chain = (table) => {
    const c = { table, calls: [], cond: null };
    const rec = (name) => jest.fn((...args) => { c.calls.push([name, ...args]); return c; });
    for (const m of ['leftJoin', 'select', 'orderBy', 'whereNull', 'whereNotIn', 'whereNot']) c[m] = rec(m);
    c.where = jest.fn((...args) => {
      c.calls.push(['where', ...args]);
      if (args.length === 1 && typeof args[0] === 'object') c.cond = { ...(c.cond || {}), ...args[0] };
      return c;
    });
    c.first = jest.fn(async (...args) => {
      c.calls.push(['first', ...args]);
      if (table === 'equipment' && c.cond && c.cond.assigned_to && c.cond.category === 'vehicle') return state.trucksOf[c.cond.assigned_to] || null;
      if (table === 'equipment' && c.cond && c.cond.category === 'vehicle') return state.vehicles[c.cond.id] || null;
      if (table === 'equipment' && c.cond && c.cond.id && c.cond.category === undefined) return state.rows[c.cond.id] ? { ...state.rows[c.cond.id] } : null;
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
  db.transaction = jest.fn(async (fn) => fn(db));
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
  s.rows = { [TOOL]: { id: TOOL, category: 'tool', assigned_vehicle_id: VEHICLE }, [OTHER]: { id: OTHER, category: 'vehicle' } };
  s.riders = { [VEHICLE]: { id: TOOL } };
  s.trucksOf = {};
  s.rows[VEHICLE] = { id: VEHICLE, category: 'vehicle', assigned_to: 'tech-1', status: 'active' };
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

  test('a truck with riders cannot be retired, sold or lost either', async () => {
    for (const status of ['retired', 'sold', 'lost']) {
      const res = await run('put', '/equipment/:id', { params: { id: VEHICLE }, body: { status } });
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatch(/still ride/);
    }
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
    // Placed straight onto a truck: that truck's lock is taken before the insert.
    expect(require('../services/truck-kit').lockTruck).toHaveBeenCalledWith(db, VEHICLE);
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
    expect(res.body).toEqual({ error: 'assigned_vehicle_id must be a live vehicle' });
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

// PR 2: the kit key rides with the custody columns and the dialog's
// suggestions come from the truck kit's vocabulary.
jest.mock('../services/truck-kit', () => ({
  truckKitEnabled: jest.fn(() => true),
  kitKeyVocabulary: jest.fn(async () => [{ kit_key: 'moisture_meter', label: 'Moisture meter' }]),
  lockTruck: jest.fn(async () => ({ rows: [] })),
  closeTruckBellIfClear: jest.fn(async () => true),
  openToolAlertFor: jest.fn(async () => null),
  lockTechnician: jest.fn(async () => ({ rows: [] })),
}));
const truckKit = require('../services/truck-kit');

describe('a tool leaving a truck re-judges that truck\'s bell', () => {
  test('a save that raced another move of the same item is refused', async () => {
    // The first read says VEHICLE; under the locks the row already moved to OTHER.
    let reads = 0;
    db.__state.rows[TOOL] = { id: TOOL, category: 'tool', get assigned_vehicle_id() { return reads++ === 0 ? VEHICLE : OTHER; } };
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: null } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/changed this item/);
    expect(db.__state.updated).toBeNull();
  });

  test('a create onto a truck retired while it waited for the lock is refused', async () => {
    db.__state.vehicles[OTHER] = { id: OTHER };
    const vehicles = db.__state.vehicles;
    let reads = 0;
    Object.defineProperty(db.__state, 'vehicles', { get: () => (reads++ === 0 ? vehicles : { [VEHICLE]: vehicles[VEHICLE] }), configurable: true });
    const res = await run('post', '/equipment', { body: { name: 'Synthetic probe', category: 'tool', assigned_vehicle_id: OTHER } });
    Object.defineProperty(db.__state, 'vehicles', { value: vehicles, writable: true, configurable: true });
    expect(res.statusCode).toBe(409);
    expect(db.__state.inserted).toBeNull();
  });

  test('a row that became a vehicle while the save waited cannot end up as cargo', async () => {
    // vehicleTarget saw a tool; under the locks the stored row is a vehicle (both snapshots agree).
    let reads = 0;
    db.__state.rows[TOOL] = { id: TOOL, assigned_vehicle_id: null, status: 'active', get category() { return reads++ === 0 ? 'tool' : 'vehicle'; } };
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: VEHICLE } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/cannot ride on a truck/);
    expect(db.__state.updated).toBeNull();
    db.__state.rows[TOOL] = { id: TOOL, category: 'tool', assigned_vehicle_id: VEHICLE };
  });

  test('a Lost outcome that landed while the save waited is not undone by the dialog payload', async () => {
    let reads = 0;
    // Reads: the target check, the first snapshot (both active), then the under-lock snapshot (lost).
    db.__state.rows[TOOL] = { id: TOOL, category: 'tool', assigned_vehicle_id: VEHICLE, get status() { return reads++ < 2 ? 'active' : 'lost'; } };
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { status: 'active', name: 'Full payload', assigned_vehicle_id: VEHICLE } });
    expect(res.statusCode).toBe(409);
    expect(db.__state.updated).toBeNull();
    db.__state.rows[TOOL] = { id: TOOL, category: 'tool', assigned_vehicle_id: VEHICLE };
  });

  test('a form opened before a Lost outcome landed cannot resurrect the item (expected_status)', async () => {
    db.__state.rows[TOOL] = { id: TOOL, category: 'tool', assigned_vehicle_id: VEHICLE, status: 'lost' };
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { status: 'active', expected_status: 'active' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/status changed since you opened it/);
    expect(db.__state.updated).toBeNull();
    // The same form with the status it really loaded saves.
    expect((await run('put', '/equipment/:id', { params: { id: TOOL }, body: { status: 'active', expected_status: 'lost' } })).statusCode).toBe(200);
    db.__state.rows[TOOL] = { id: TOOL, category: 'tool', assigned_vehicle_id: VEHICLE };
  });

  test('every save of an item takes the item\'s own lock first', async () => {
    await run('put', '/equipment/:id', { params: { id: TOOL }, body: { name: 'Renamed' } });
    expect(truckKit.lockTruck.mock.calls[0]).toEqual([db, TOOL]);
  });

  test('a target truck retired while the save waited for its lock is refused', async () => {
    // vehicleTarget saw OTHER as a live vehicle; under the lock it is gone.
    db.__state.vehicles[OTHER] = { id: OTHER };
    const vehicles = db.__state.vehicles;
    let reads = 0;
    Object.defineProperty(db.__state, 'vehicles', { get: () => (reads++ === 0 ? vehicles : { [VEHICLE]: vehicles[VEHICLE] }), configurable: true });
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: OTHER } });
    Object.defineProperty(db.__state, 'vehicles', { value: vehicles, writable: true, configurable: true });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/no longer a live vehicle/);
    expect(db.__state.updated).toBeNull();
  });

  test('moving a tool to another truck locks both trucks and re-judges the old one, in the update transaction', async () => {
    db.__state.vehicles[OTHER] = { id: OTHER };
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: OTHER } });
    expect(res.statusCode).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const truckLocks = () => truckKit.lockTruck.mock.calls.map(([, id]) => id).filter((id) => id !== TOOL);
    expect(truckLocks().sort()).toEqual([VEHICLE, OTHER].sort());
    expect(truckKit.closeTruckBellIfClear).toHaveBeenCalledWith(VEHICLE, expect.any(Date), db);
  });

  test('a tool with an open truck check alert cannot move or leave its truck', async () => {
    truckKit.openToolAlertFor.mockResolvedValueOnce({ id: 'alert-1' });
    const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: null } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/open truck check alert/);
    expect(db.__state.updated).toBeNull();
    expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
  });

  test('an item with an open truck check alert cannot go lost, retired or sold from the dialog', async () => {
    truckKit.openToolAlertFor.mockResolvedValue({ id: 'alert-1' });
    for (const status of ['lost', 'retired', 'sold']) {
      const res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { status, assigned_vehicle_id: VEHICLE } });
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatch(/Found \/ Lost/);
    }
    expect(db.__state.updated).toBeNull();
    // The item's truck is locked before the alert check, so a check in flight finishes first.
    expect(truckKit.lockTruck).toHaveBeenCalledWith(db, VEHICLE);
    // Re-entering the live kit (maintenance → active) locks the truck too.
    jest.clearAllMocks();
    truckKit.openToolAlertFor.mockResolvedValue(null);
    expect((await run('put', '/equipment/:id', { params: { id: TOOL }, body: { status: 'active' } })).statusCode).toBe(200);
    expect(truckKit.lockTruck).toHaveBeenCalledWith(db, VEHICLE);
    truckKit.openToolAlertFor.mockResolvedValue({ id: 'alert-1' });
    // Any other edit of that item still saves.
    expect((await run('put', '/equipment/:id', { params: { id: TOOL }, body: { name: 'Renamed', assigned_vehicle_id: VEHICLE } })).statusCode).toBe(200);
    truckKit.openToolAlertFor.mockResolvedValue(null);
  });

  test('a technician never holds two live trucks', async () => {
    db.__state.trucksOf['tech-1'] = { id: VEHICLE };
    let res = await run('post', '/equipment', { body: { name: 'Second van', category: 'vehicle', assigned_to: 'tech-1' } });
    expect(res.statusCode).toBe(409);
    expect(db.__state.inserted).toBeNull();
    // The check and the write serialize on the technician's lock, in one transaction.
    expect(truckKit.lockTechnician).toHaveBeenCalledWith(db, 'tech-1');
    expect(db.transaction).toHaveBeenCalled();
    jest.clearAllMocks();
    res = await run('put', '/equipment/:id', { params: { id: OTHER }, body: { assigned_to: 'tech-1' } });
    expect(res.statusCode).toBe(409);
    expect(db.__state.updated).toBeNull();
    expect(truckKit.lockTechnician).toHaveBeenCalledWith(db, 'tech-1');
    // The repair the message asks for: clearing one truck's technician saves.
    db.__state.rows[OTHER] = { id: OTHER, category: 'vehicle', assigned_to: 'tech-1', status: 'active' };
    expect((await run('put', '/equipment/:id', { params: { id: OTHER }, body: { assigned_to: null } })).statusCode).toBe(200);
    expect(db.__state.updated).toEqual(expect.objectContaining({ assigned_to: null }));
    // A retired second vehicle, or a tool, is fine.
    expect((await run('post', '/equipment', { body: { name: 'Old van', category: 'vehicle', assigned_to: 'tech-1', status: 'retired' } })).statusCode).toBe(201);
    expect((await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_to: 'tech-1' } })).statusCode).toBe(200);
  });

  test('handing a truck to another technician takes the truck lock', async () => {
    await run('put', '/equipment/:id', { params: { id: OTHER }, body: { assigned_to: 'tech-2' } });
    expect(truckKit.lockTruck).toHaveBeenCalledWith(db, OTHER);
    expect(db.__state.updated).toEqual(expect.objectContaining({ assigned_to: 'tech-2' }));
    // So does retiring or recategorizing the vehicle row itself.
    jest.clearAllMocks();
    await run('put', '/equipment/:id', { params: { id: OTHER }, body: { status: 'retired' } });
    expect(truckKit.lockTruck).toHaveBeenCalledWith(db, OTHER);
    jest.clearAllMocks();
    await run('put', '/equipment/:id', { params: { id: TOOL }, body: { name: 'Renamed' } });
    // Only the item's own lock, never a truck's.
    expect(truckKit.lockTruck.mock.calls.map(([, id]) => id)).toEqual([TOOL]);
  });

  test('unassigning a tool re-judges its old truck; a save that keeps the truck touches no bell', async () => {
    await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: null } });
    expect(truckKit.closeTruckBellIfClear).toHaveBeenCalledWith(VEHICLE, expect.any(Date), db);
    jest.clearAllMocks();
    await run('put', '/equipment/:id', { params: { id: TOOL }, body: { assigned_vehicle_id: VEHICLE, name: 'Renamed' } });
    expect(truckKit.closeTruckBellIfClear).not.toHaveBeenCalled();
    const truckLocks = () => truckKit.lockTruck.mock.calls.map(([, id]) => id).filter((id) => id !== TOOL);
    expect(truckLocks()).toEqual([VEHICLE]);
    await run('put', '/equipment/:id', { params: { id: TOOL }, body: { name: 'Renamed again' } });
    expect(truckLocks()).toEqual([VEHICLE]);
  });
});

describe('kit key', () => {
  test('is normalized to snake_case, cleared when blank, refused when not a key', async () => {
    let res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { kit_key: ' Moisture Meter ' } });
    expect(res.statusCode).toBe(200);
    expect(db.__state.updated).toEqual(expect.objectContaining({ kit_key: 'moisture_meter' }));
    res = await run('put', '/equipment/:id', { params: { id: TOOL }, body: { kit_key: '' } });
    expect(db.__state.updated).toEqual(expect.objectContaining({ kit_key: null }));
    res = await run('post', '/equipment', { body: { name: 'Synthetic duster', kit_key: 'bad key!' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/kit_key/);
    expect(db.__state.inserted).toBeNull();
  });

  test('GET /kit-keys answers the vocabulary with the gate on, 404 enabled:false with it off', async () => {
    const res = await run('get', '/kit-keys');
    expect(res.body).toEqual({ enabled: true, keys: [{ kit_key: 'moisture_meter', label: 'Moisture meter' }] });
    require('../services/truck-kit').truckKitEnabled.mockReturnValueOnce(false);
    const dark = await run('get', '/kit-keys');
    expect(dark.statusCode).toBe(404);
    expect(dark.body).toEqual({ enabled: false });
  });
});
