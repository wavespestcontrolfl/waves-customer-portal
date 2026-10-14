// The staff switch for lawn bermuda removal (GATE_LAWN_BERMUDA_REMOVAL):
// PUT /api/admin/customers/:customerId/turf-profile/bermuda-removal, and the
// turf-profile GET payload. Handlers run for real over a fake db.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: jest.fn(async () => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { requireAdmin } = require('../middleware/admin-auth');
const router = require('../routes/admin-customer-turf-profile');

const route = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
const putRoute = route('/:customerId/turf-profile/bermuda-removal', 'put');
const getHandler = route('/:customerId/turf-profile', 'get').stack[0].handle;

function fakeDb({ customer = { id: 'c1' }, profile = null, row = null, updated = true } = {}) {
  const updates = [];
  db.mockImplementation((table) => {
    const q = {};
    q.wheres = [];
    q.where = jest.fn((arg) => { q.wheres.push(arg); return q; });
    q.whereIn = jest.fn((col, values) => { q.wheres.push({ [col]: values }); return q; });
    q.whereRaw = jest.fn((sql, bindings) => { q.wheres.push({ raw: sql, bindings }); return q; });
    q.first = jest.fn(async () => (table === 'customers' ? customer : table === 'customer_turf_profiles' ? (row || profile) : { irrigation_home_changed_at: null }));
    q.update = jest.fn((fields) => { updates.push({ table, fields, wheres: q.wheres }); return { returning: async () => (updated ? [{ id: 'p1', customer_id: 'c1', ...fields }] : []) }; });
    return q;
  });
  return updates;
}
const call = async (handler, req) => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ params: { customerId: 'c1' }, technicianId: 'tech-1', techRole: 'admin', body: {}, ...req }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
};
const put = (body) => call(putRoute.stack[putRoute.stack.length - 1].handle, { body });

beforeEach(() => { jest.clearAllMocks(); process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true'; });
afterEach(() => { delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });

describe('PUT bermuda-removal', () => {
  test('is admin-only: requireAdmin runs before the handler', () => {
    expect(putRoute.stack.length).toBe(2);
    const next = jest.fn();
    putRoute.stack[0].handle({ techRole: 'technician' }, {}, next);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  test('gate off: 404 and nothing written', async () => {
    delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'zoysia', active: true } });
    const res = await put({ enabled: true });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(updates).toEqual([]);
  });

  test.each([[undefined], ['true'], [1], [null]])('enabled must be a boolean (%p)', async (enabled) => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'zoysia', active: true } });
    const res = await put({ enabled });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(updates).toEqual([]);
  });

  test('no turf profile yet: 400', async () => {
    fakeDb({ profile: null });
    expect((await put({ enabled: true })).status).toHaveBeenCalledWith(400);
  });

  test.each(['bermuda', 'bahia', 'mixed', 'unknown', null])('turning it on for %p grass is refused', async (grass) => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: grass, active: true } });
    const res = await put({ enabled: true });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(updates).toEqual([]);
  });

  test.each(['st_augustine', 'zoysia'])('turning it on for %s stamps who and when and moves updated_at', async (grass) => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: grass, active: true } });
    const res = await put({ enabled: true });
    expect(res.status).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toMatchObject({ bermuda_removal: true, bermuda_removal_set_by: 'tech-1' });
    expect(updates[0].fields.bermuda_removal_set_at).toBeInstanceOf(Date);
    expect(updates[0].fields.updated_at).toBeInstanceOf(Date);
    expect(res.json.mock.calls[0][0].profile.bermuda_removal).toBe(true);
  });

  test('an inactive profile cannot be switched on', async () => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'zoysia', active: false } });
    const res = await put({ enabled: true });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(updates).toEqual([]);
  });

  test.each(['ProVista', 'captiva', 'Seville dwarf', ' SEVILLE '])('St. Augustine cultivar %p never gets it', async (cultivar) => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'st_augustine', cultivar, active: true } });
    const res = await put({ enabled: true });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(updates).toEqual([]);
  });

  test.each([['Floratam'], ['CitraBlue'], [null], ['mystery sod']])('St. Augustine cultivar %p may be switched on (the plan adds the test-patch note where needed)', async (cultivar) => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'st_augustine', cultivar, active: true } });
    await put({ enabled: true });
    expect(updates).toHaveLength(1);
  });

  test('Zoysia has no cultivar rule', async () => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'zoysia', cultivar: 'ProVista', active: true } });
    await put({ enabled: true });
    expect(updates).toHaveLength(1);
  });

  test('turning it on puts the active and eligible-grass conditions in the UPDATE itself; a lost race is a 409', async () => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'zoysia', active: true }, updated: false });
    const res = await put({ enabled: true });
    expect(updates[0].wheres).toEqual(expect.arrayContaining([{ active: true }, { grass_type: ['st_augustine', 'zoysia'] }]));
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('turning it on carries the excluded-cultivar rule in the UPDATE, so a cultivar changed after the read makes it hit no row (409)', async () => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'st_augustine', cultivar: 'Floratam', active: true }, updated: false });
    const res = await put({ enabled: true });
    const raw = updates[0].wheres.find((w) => w.raw);
    expect(raw.raw).toMatch(/regexp_replace\(lower\(cultivar\)/);
    expect(raw.bindings).toEqual(['%provista%', '%captiva%', '%seville%']);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('turning it off has no active or grass condition', async () => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'bahia', active: false } });
    await put({ enabled: false });
    expect(updates[0].wheres).toEqual([{ customer_id: 'c1' }]);
  });

  test('turning it off is always allowed, even after the grass changed to one that is not eligible', async () => {
    const updates = fakeDb({ profile: { id: 'p1', grass_type: 'bahia', active: true } });
    await put({ enabled: false });
    expect(updates[0].fields.bermuda_removal).toBe(false);
  });
});

describe('GET turf-profile payload', () => {
  const profile = { id: 'p1', grass_type: 'zoysia', bermuda_removal: true, bermuda_removal_set_by: 'tech-1', bermuda_removal_set_at: new Date() };

  test('gate off: the old payload (no bermuda columns, no availability flag)', async () => {
    delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
    fakeDb({ profile });
    const body = (await call(getHandler, {})).json.mock.calls[0][0];
    expect(Object.keys(body.profile).sort()).toEqual(['grass_type', 'id']);
    expect(body).not.toHaveProperty('bermudaRemovalAvailable');
  });

  test('gate on, admin: the columns and the availability flag ride along', async () => {
    fakeDb({ profile });
    const body = (await call(getHandler, {})).json.mock.calls[0][0];
    expect(body.profile.bermuda_removal).toBe(true);
    expect(body.bermudaRemovalAvailable).toBe(true);
  });

  test('gate on, technician: the old payload, so the switch never shows', async () => {
    fakeDb({ profile });
    const body = (await call(getHandler, { techRole: 'technician' })).json.mock.calls[0][0];
    expect(Object.keys(body.profile).sort()).toEqual(['grass_type', 'id']);
    expect(body).not.toHaveProperty('bermudaRemovalAvailable');
  });
});
