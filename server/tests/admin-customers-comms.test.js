jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockReadHistory = jest.fn();
jest.mock('../services/customer-history', () => ({ listCustomerComms: mockReadHistory }));
let mockCustomer;
jest.mock('../models/db', () => jest.fn(() => {
  const query = { where: () => query, whereNull: () => query, first: async () => mockCustomer };
  return query;
}));
const db = require('../models/db');
const router = require('../routes/admin-customers');
const handler = router.stack.find(layer => layer.route?.path === '/:id/comms').route.stack.at(-1).handle;

beforeEach(() => {
  mockCustomer = { id: 'synthetic-customer', phone: '+12025550100' };
  mockReadHistory.mockReset();
});

test('communication pagination delegates filters, cursors, and customer fallback fields', async () => {
  const query = { limit: '25', channel: 'voice', cursor: 'opaque' };
  const result = { comms: [], hasMore: false, nextCursor: null };
  mockReadHistory.mockResolvedValue(result);
  const res = { json: jest.fn() };
  const next = jest.fn();
  await handler({ params: { id: mockCustomer.id }, query }, res, next);
  expect(mockReadHistory).toHaveBeenCalledWith(db, mockCustomer, query);
  expect(res.json).toHaveBeenCalledWith(result);
  expect(next).not.toHaveBeenCalled();
});

test.each([404, 400, 500])('communication history handles %i errors without sending partial history', async (status) => {
  if (status === 404) mockCustomer = null;
  const error = Object.assign(new Error('Synthetic failure'), { status });
  mockReadHistory.mockRejectedValue(error);
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({ params: { id: 'synthetic-customer' }, query: {} }, res, next);
  if (status === 500) expect(next).toHaveBeenCalledWith(error);
  else expect(res.status).toHaveBeenCalledWith(status);
  if (status === 404) expect(mockReadHistory).not.toHaveBeenCalled();
});
