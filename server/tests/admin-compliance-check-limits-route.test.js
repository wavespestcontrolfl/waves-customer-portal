// POST /api/admin/compliance/check-limits passes the treated property to the checker when the
// request names one, so a yearly count is that lawn's; with none it is left to the checker's own
// per-lawn evaluation.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next() }));
jest.mock('../services/application-limits', () => ({ checkLimits: jest.fn(async () => ({ allowed: true, warnings: [], blocks: [] })) }));

const LimitChecker = require('../services/application-limits');
const router = require('../routes/admin-compliance');

async function post(body) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/check-limits' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  await handler({ body }, res, (err) => { throw err; });
  return res;
}

beforeEach(() => LimitChecker.checkLimits.mockClear());

test('a named property is passed to the checker', async () => {
  const res = await post({ customerId: 'c1', propertyId: 'p1', products: [{ productId: 'prod-1', name: 'X' }] });
  expect(res.body.allowed).toBe(true);
  expect(LimitChecker.checkLimits).toHaveBeenCalledWith('c1', 'prod-1', expect.any(Date), undefined, { propertyId: 'p1' });
});

test('no property: the checker is asked without one (it then judges the busiest property of the customer)', async () => {
  await post({ customerId: 'c1', products: [{ productId: 'prod-1' }] });
  expect(LimitChecker.checkLimits).toHaveBeenCalledWith('c1', 'prod-1', expect.any(Date), undefined, { propertyId: null });
});

test('customerId and products are still required', async () => {
  expect((await post({ products: [] })).statusCode).toBe(400);
});
