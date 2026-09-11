jest.mock('../models/db', () => {
  const db = jest.fn(() => chain);
  const chain = { where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    modify: fn => { fn(chain); return chain; }, first: jest.fn() };
  db.chain = chain;
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: function adminAuthenticate(req, res, next) { next(); },
  requireTechOrAdmin: function requireTechOrAdmin(req, res, next) { next(); },
}));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
const db = require('../models/db');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const router = require('../routes/admin-treatment-plans');

async function run({ body = {}, query = {}, tech = false, post = false } = {}) {
  const route = router.stack.find(layer => layer.route?.methods[post ? 'post' : 'get']);
  const res = { statusCode: 200, set: jest.fn(), status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await route.route.stack.at(-1).handle({ body, query, params: { serviceId: 'visit' }, techRole: tech ? 'technician' : 'admin', technicianId: 'tech' }, res, error => { throw error; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  db.chain.first.mockResolvedValue({ id: 'visit' });
  buildPlanForService.mockResolvedValue({ completionDefaults: { enabled: true } });
});
afterEach(() => { delete process.env.GATE_LAWN_COMPLETION_DEFAULTS; delete process.env.GATE_LAWN_PROPERTY_HISTORY; });

test('the existing router retains both authentication and staff role guards', () => {
  expect(router.stack.slice(0, 2).map(layer => layer.handle.name)).toEqual(['adminAuthenticate', 'requireTechOrAdmin']);
});
test.each([4000, null])('visit area %s reaches the read-only builder without coercion', async lawnSqft => {
  const response = await run({ post: true, body: { completionDefaults: true, lawnSqft } });
  expect(buildPlanForService).toHaveBeenCalledWith('visit', expect.objectContaining({ lawnSqft, includeCompletionDefaults: true, completionDefaultsEnabled: true }));
  expect(response.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
});
test.each(['4000', '', false, 0, -1, 10000001, 2500.5])('invalid visit area %j is rejected before building', async lawnSqft => {
  await expect(run({ post: true, body: { completionDefaults: true, lawnSqft } })).rejects.toMatchObject({ statusCode: 400 });
  expect(buildPlanForService).not.toHaveBeenCalled();
});
test('gate-off cannot accept a visit-area override', async () => {
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  await expect(run({ post: true, body: { completionDefaults: true, lawnSqft: 4000 } })).rejects.toMatchObject({ statusCode: 400 });
  await run({ query: { completionDefaults: '1' } });
  expect(buildPlanForService).toHaveBeenCalledWith('visit', expect.objectContaining({ completionDefaultsEnabled: false }));
});
test.each([false, true])('tech assignment is enforced before and after the plan read (post=%s)', async post => {
  const request = { post, tech: true, query: { completionDefaults: '1' } };
  db.chain.first.mockResolvedValueOnce(null);
  expect((await run(request)).statusCode).toBe(404);
  expect(buildPlanForService).not.toHaveBeenCalled();
  db.chain.first.mockResolvedValueOnce({ id: 'visit' }).mockResolvedValueOnce(null);
  expect((await run(request)).statusCode).toBe(404);
  expect(db.chain.where).toHaveBeenCalledWith('scheduled_services.technician_id', 'tech');
  expect(db.chain.whereNotIn).toHaveBeenCalled();
});

test.each([true, false])('the plan response never carries propertyGate.billingMode (technician=%s) — office-only, attribution reads the server-built plan (codex #4365 P2)', async (tech) => {
  buildPlanForService.mockResolvedValue({ serviceId: 'visit', propertyGate: { serviceTier: 'Silver', billingMode: 'one_time', trackKey: 'st_augustine' }, completionDefaults: { enabled: true } });
  for (const post of [false, true]) {
    const res = await run({ tech, post, body: post ? { completionDefaults: true } : {}, query: post ? {} : { completionDefaults: '1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.plan.propertyGate).toEqual({ serviceTier: 'Silver', trackKey: 'st_augustine' });
    expect(res.body.plan.propertyGate).not.toHaveProperty('billingMode');
    expect(res.body.plan.completionDefaults).toEqual({ enabled: true });
  }
});
