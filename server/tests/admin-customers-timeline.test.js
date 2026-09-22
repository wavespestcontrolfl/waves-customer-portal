jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const timelineResult = { timeline: [{ id: 'activity:test', type: 'activity' }], missingSources: [], hasMore: false, nextCursor: null };
const mockHistory = {
  listCustomerTimeline: jest.fn(async () => timelineResult),
};
jest.mock('../services/customer-history', () => mockHistory);

let mockCustomer = { id: 'customer-test', phone: '+19415550100' };
jest.mock('../models/db', () => jest.fn(() => {
  const builder = {
    where: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    first: jest.fn(async () => mockCustomer),
  };
  return builder;
}));
const db = require('../models/db');
const router = require('../routes/admin-customers');

async function timeline(query = {}) {
  const layer = router.stack.find(item => item.route?.path === '/:id/timeline' && item.route.methods.get);
  const handler = layer.route.stack.at(-1).handle;
  const req = { params: { id: 'customer-test' }, query };
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler(req, res, next);
  return { res, next, data: res.json.mock.calls[0]?.[0] };
}

beforeEach(() => {
  mockCustomer = { id: 'customer-test', phone: '+19415550100' };
  db.mockClear();
  mockHistory.listCustomerTimeline.mockReset().mockResolvedValue(timelineResult);
});

test('timeline delegates the complete query contract after checking the customer', async () => {
  const query = { limit: '25', type: 'invoice', search: 'paid', cursor: 'opaque' };
  const { data, next } = await timeline(query);
  expect(next).not.toHaveBeenCalled();
  expect(data).toBe(timelineResult);
  expect(mockHistory.listCustomerTimeline).toHaveBeenCalledWith(db, 'customer-test', query);
});

test('timeline returns 404 before reading history', async () => {
  mockCustomer = null;
  const { res } = await timeline();
  expect(res.status).toHaveBeenCalledWith(404);
  expect(mockHistory.listCustomerTimeline).not.toHaveBeenCalled();
});

test('timeline maps validated request errors to 400', async () => {
  mockHistory.listCustomerTimeline.mockRejectedValue(Object.assign(new Error('Invalid cursor'), { status: 400 }));
  const { res, next } = await timeline();
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid cursor' });
  expect(next).not.toHaveBeenCalled();
});

test('core timeline failures still reach Express error handling', async () => {
  const error = new Error('Core source unavailable');
  mockHistory.listCustomerTimeline.mockRejectedValue(error);
  const { next } = await timeline();
  expect(next).toHaveBeenCalledWith(error);
});
