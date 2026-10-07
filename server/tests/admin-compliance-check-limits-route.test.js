// POST /api/admin/compliance/check-limits passes the treated property to the checker when the
// request names one, so a yearly count is that lawn's; with none it is left to the checker's own
// per-lawn evaluation.
const mockOwned = { value: true };
jest.mock('../models/db', () => jest.fn(() => ({ where: () => ({ first: async () => (mockOwned.value ? { id: 'p' } : undefined) }) })));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next() }));
jest.mock('../services/application-limits', () => ({ checkLimits: jest.fn(async () => ({ allowed: true, warnings: [], blocks: [] })) }));

const LimitChecker = require('../services/application-limits');
const router = require('../routes/admin-compliance');

const C1 = '00000000-0000-4000-8000-0000000000c1';
const P1 = '00000000-0000-4000-8000-0000000000a1';

async function post(body) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/check-limits' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  await handler({ body }, res, (err) => { throw err; });
  return res;
}

beforeEach(() => { LimitChecker.checkLimits.mockClear(); mockOwned.value = true; });

test('a named property is passed to the checker', async () => {
  const res = await post({ customerId: C1, propertyId: P1, products: [{ productId: 'prod-1', name: 'X' }] });
  expect(res.body.allowed).toBe(true);
  expect(LimitChecker.checkLimits).toHaveBeenCalledWith(C1, 'prod-1', expect.any(Date), undefined, { propertyId: P1 });
});

test('no property: the checker is asked without one (it then judges the busiest property of the customer)', async () => {
  await post({ customerId: C1, products: [{ productId: 'prod-1' }] });
  expect(LimitChecker.checkLimits).toHaveBeenCalledWith(C1, 'prod-1', expect.any(Date), undefined, { propertyId: null });
});

test('customerId and products are still required', async () => {
  expect((await post({ products: [] })).statusCode).toBe(400);
});

test('a propertyId that is not a UUID is a 400, before any read or check', async () => {
  const res = await post({ customerId: C1, propertyId: 'p1; drop table', products: [{ productId: 'prod-1' }] });
  expect(res.statusCode).toBe(400);
  expect(res.body.code).toBe('invalid_property_id');
  expect(LimitChecker.checkLimits).not.toHaveBeenCalled();
  expect((await post({ customerId: 'not-a-uuid', propertyId: P1, products: [{ productId: 'prod-1' }] })).statusCode).toBe(400);
  expect((await post({ customerId: C1, propertyId: 42, products: [{ productId: 'prod-1' }] })).statusCode).toBe(400);
});

test('a property that belongs to another customer is a 404 and nothing is checked', async () => {
  mockOwned.value = false;
  const res = await post({ customerId: C1, propertyId: P1, products: [{ productId: 'prod-1' }] });
  expect(res.statusCode).toBe(404);
  expect(res.body.code).toBe('property_not_found');
  expect(LimitChecker.checkLimits).not.toHaveBeenCalled();
});
