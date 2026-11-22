// GET /api/admin/customers/:id/activity — admin-only, read-only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockGet = jest.fn();
jest.mock('../services/customer-activity-timeline', () => ({ getCustomerActivity: (...a) => mockGet(...a) }));
jest.mock('../models/db', () => jest.fn(() => ({ where: () => ({}) })));

const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const router = require('../routes/admin-customers');

const layer = router.stack.find((l) => l.route?.path === '/:id/activity');
const handler = layer.route.stack.at(-1).handle;

beforeEach(() => { mockGet.mockReset(); });

const call = async (req) => {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({ params: { id: 'cust-1' }, query: {}, ...req }, res, next);
  return { res, next };
};

test('is GET-only, admin-only (not technician) and sits behind the router-level admin auth', () => {
  expect(Object.keys(layer.route.methods)).toEqual(['get']);
  expect(layer.route.stack[0].handle).toBe(requireAdmin);
  const routerGuards = router.stack.filter((l) => !l.route).slice(0, 2).map((l) => l.handle);
  expect(routerGuards).toEqual([adminAuthenticate, requireTechOrAdmin]);
});

test('passes the customer, cursor and limit through and answers the feed, still marked enabled for older open tabs', async () => {
  mockGet.mockResolvedValue({ events: [{ id: 'a' }], hasMore: false, nextCursor: null, summary: null, unavailableSources: [] });
  const { res } = await call({ query: { before: '2026-09-01T00:00:00Z', limit: '25' } });
  expect(mockGet).toHaveBeenCalledWith('cust-1', { before: '2026-09-01T00:00:00Z', limit: '25' });
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, events: [{ id: 'a' }] }));
});

test('unknown customer is 404, a bad cursor is 400, anything else goes to next()', async () => {
  mockGet.mockResolvedValueOnce(null);
  const notFound = await call({});
  expect(notFound.res.status).toHaveBeenCalledWith(404);

  mockGet.mockRejectedValueOnce(Object.assign(new Error('before must be a valid date'), { status: 400 }));
  const bad = await call({ query: { before: 'x' } });
  expect(bad.res.status).toHaveBeenCalledWith(400);

  const boom = new Error('db down');
  mockGet.mockRejectedValueOnce(boom);
  const failed = await call({});
  expect(failed.next).toHaveBeenCalledWith(boom);
});

test('an array-valued or empty cursor is not forwarded as a cursor', async () => {
  mockGet.mockResolvedValue({ events: [] });
  await call({ query: { before: ['a', 'b'] } });
  await call({ query: { before: '' } });
  expect(mockGet.mock.calls[0][1].before).toBeNull();
  expect(mockGet.mock.calls[1][1].before).toBeNull();
});
