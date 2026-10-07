// GET /api/services/stats/summary sends celsiusMaxPerYear, which the portal's Celsius copy is built from.
// It comes from the one canonical reader (config/lawn-v13-count-caps celsiusYtdCap, which lawn-expectations re-exports), not a second
// "gate ? 2 : 3" copy: 2 under the v13 lawn program, 3 with GATE_LAWN_V13 off.
jest.mock('../models/db', () => {
  const rows = { count: '0' };
  const make = () => {
    const q = {};
    for (const m of ['where', 'whereNotNull', 'whereIn', 'whereNull', 'orderBy', 'select', 'leftJoin', 'join', 'count']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => rows);
    return q;
  };
  return jest.fn(() => make());
});
jest.mock('../services/photos', () => ({ getPhotosForService: jest.fn(async () => []), photoUrl: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/review-request', () => ({ livePortalReviewUrlFor: jest.fn(), reviewSmsAllowedNow: jest.fn(async () => ({ allowed: true })), _liveReviewToken: jest.fn(async () => null) }));
jest.mock('../middleware/auth', () => ({ authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); } }));

const router = require('../routes/services');

async function stats() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/stats/summary' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { json(payload) { this.body = payload; return this; } };
  await handler({ customerId: 'cust-1' }, res, (err) => { throw err; });
  return res.body;
}

describe('celsiusMaxPerYear', () => {
  const saved = process.env.GATE_LAWN_V13;
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved; jest.restoreAllMocks(); });

  test('2 with GATE_LAWN_V13 on, 3 with it off', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    expect((await stats()).celsiusMaxPerYear).toBe(2);
    delete process.env.GATE_LAWN_V13;
    expect((await stats()).celsiusMaxPerYear).toBe(3);
  });

  test('it comes from the canonical reader, not a second copy of the rule (the route imports and calls celsiusYtdCap)', async () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'services.js'), 'utf8');
    expect(source).toMatch(/const \{ celsiusYtdCap \} = require\('\.\.\/config\/lawn-v13-count-caps'\)/);
    expect(source).toMatch(/celsiusMaxPerYear: celsiusYtdCap\(\)/);
    expect(source).not.toMatch(/lawnV13Live\(\) \? 2 : 3/);
  });
});

test('the report engine and the route share the one reader', () => {
  const expectations = require('../config/lawn-expectations');
  const caps = require('../config/lawn-v13-count-caps');
  expect(expectations.celsiusYtdCap).toBe(caps.celsiusYtdCap);
  expect(expectations.CELSIUS_YTD_CAP).toBe(2);
  expect(expectations.CELSIUS_YTD_CAP_LEGACY).toBe(3);
});
