// GATE_ESTIMATE_LAWN_LIMITS on the turf profile routes: the two flags the office sets from
// the estimate photos (other_grasses, virus_streaks_suspected). Handlers run for real over a
// fake db. Gate off: the columns are not read, written or returned.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: jest.fn(async () => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-pricing-ai', () => ({
  withTurfProfileFence: jest.fn(async (knex, customerId, fn) => fn(global.__fakeTrx)),
}));

const db = require('../models/db');
const router = require('../routes/admin-customer-turf-profile');

const route = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
const getHandler = route('/:customerId/turf-profile', 'get').stack[0].handle;
const putHandler = route('/:customerId/turf-profile', 'put').stack[0].handle;

// Stored row as the database would return it (the new columns are present on every row once migrated).
const STORED = { id: 'p1', customer_id: 'c1', grass_type: 'st_augustine', other_grasses: ['carpetgrass'], virus_streaks_suspected: true };

function fakeDbs({ stored = STORED } = {}) {
  const writes = [];
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customers' ? { id: 'c1' } : table === 'customer_turf_profiles' ? stored : { irrigation_home_changed_at: null }));
    return q;
  });
  global.__fakeTrx = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customer_turf_profiles' ? { grass_type: 'st_augustine', lawn_sqft: null } : { irrigation_home_changed_at: null }));
    q.insert = jest.fn((row) => { writes.push({ table, insert: row }); return q; });
    q.onConflict = jest.fn(() => q);
    q.merge = jest.fn((fields) => { writes[writes.length - 1].merge = fields; return q; });
    q.returning = jest.fn(async () => [{ ...stored, ...(writes[writes.length - 1]?.merge || {}) }]);
    return q;
  };
  return writes;
}

const call = async (handler, req) => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ params: { customerId: 'c1' }, technicianId: 'tech-1', techRole: 'technician', body: {}, ...req }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
};
const put = (body) => call(putHandler, { body });

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete process.env.GATE_ESTIMATE_LAWN_LIMITS; });

describe('GET turf-profile', () => {
  test('gate off: the two columns are not returned and the editor is told nothing', async () => {
    fakeDbs();
    const res = await call(getHandler, {});
    const body = res.json.mock.calls[0][0];
    expect(body.profile).toEqual({ id: 'p1', customer_id: 'c1', grass_type: 'st_augustine' });
    expect(body).not.toHaveProperty('lawnLimitsAvailable');
    expect(body).not.toHaveProperty('otherGrassOptions');
  });

  test('gate on: the columns are returned and the editor gets the closed list of grasses', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    fakeDbs();
    const body = (await call(getHandler, {})).json.mock.calls[0][0];
    expect(body.profile).toMatchObject({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true });
    expect(body.lawnLimitsAvailable).toBe(true);
    expect(body.otherGrassOptions).toEqual(['carpetgrass', 'bahiagrass', 'bermudagrass', 'torpedograss', 'dallisgrass']);
  });

  test('gate on, no profile yet: null profile, still available', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    fakeDbs({ stored: null });
    const body = (await call(getHandler, {})).json.mock.calls[0][0];
    expect(body.profile).toBeNull();
    expect(body.lawnLimitsAvailable).toBe(true);
  });
});

describe('PUT turf-profile validation and write', () => {
  test('gate off: the flags in the body are ignored (not validated, not written, not returned)', async () => {
    const writes = fakeDbs();
    const res = await put({ grass_type: 'st_augustine', other_grasses: ['not-a-grass'], virus_streaks_suspected: 'yes' });
    expect(res.status).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0].insert).not.toHaveProperty('other_grasses');
    expect(writes[0].insert).not.toHaveProperty('virus_streaks_suspected');
    expect(writes[0].merge).not.toHaveProperty('other_grasses');
    expect(res.json.mock.calls[0][0].profile).not.toHaveProperty('other_grasses');
  });

  test.each([
    [{ other_grasses: ['kikuyu'] }],
    [{ other_grasses: ['carpetgrass', 'zoysia'] }],
    [{ other_grasses: 'carpetgrass' }],
    [{ other_grasses: { 0: 'carpetgrass' } }],
    [{ virus_streaks_suspected: 'true' }],
    [{ virus_streaks_suspected: 1 }],
  ])('gate on: %j is refused with 400 and nothing is written', async (body) => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const writes = fakeDbs();
    const res = await put(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(writes).toEqual([]);
  });

  test('gate on: a valid list is stored clean, ordered and de-duplicated', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const writes = fakeDbs();
    const res = await put({ other_grasses: ['dallisgrass', 'carpetgrass', 'carpetgrass'], virus_streaks_suspected: true });
    expect(res.status).not.toHaveBeenCalled();
    expect(writes[0].insert).toMatchObject({ other_grasses: ['carpetgrass', 'dallisgrass'], virus_streaks_suspected: true });
    expect(writes[0].merge).toMatchObject({ other_grasses: ['carpetgrass', 'dallisgrass'], virus_streaks_suspected: true });
    expect(res.json.mock.calls[0][0].profile).toMatchObject({ other_grasses: ['carpetgrass', 'dallisgrass'] });
  });

  test('gate on: an empty list clears the flags to NULL; false is stored as false', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const writes = fakeDbs();
    await put({ other_grasses: [], virus_streaks_suspected: false });
    expect(writes[0].merge).toMatchObject({ other_grasses: null, virus_streaks_suspected: false });
  });

  test('gate on: a body without the flags leaves them out of the write', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const writes = fakeDbs();
    await put({ grass_type: 'st_augustine' });
    expect(writes[0].merge).not.toHaveProperty('other_grasses');
    expect(writes[0].merge).not.toHaveProperty('virus_streaks_suspected');
  });
});
