/**
 * ReviewService.getByToken treats an expired review link exactly like an
 * unknown one: resolves null before the open-count stamp and before any
 * customer read, so /api/review/:token maps it to the same generic 404
 * (docs/public-route-contracts.md). Mirrors submitRating's expiry test.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));

const db = require('../models/db');
const ReviewService = require('../services/review-request');

const TOKEN = 'ab'.repeat(32);

function installDb({ request }) {
  const update = jest.fn(async () => 1);
  const tables = {
    review_requests: () => {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => request),
        update,
      };
      return q;
    },
    customers: () => {
      const q = {
        select: jest.fn(() => q),
        where: jest.fn(() => q),
        first: jest.fn(async () => ({ first_name: 'Megan', last_name: 'Example', city: 'Bradenton', zip: '34211' })),
      };
      return q;
    },
  };
  const touched = [];
  db.mockImplementation((table) => {
    touched.push(table);
    if (!tables[table]) throw new Error(`unexpected table ${table}`);
    return tables[table]();
  });
  return { update, touched };
}

beforeEach(() => db.mockReset());

test('expired link resolves null with no open stamp and no customer read', async () => {
  const { update, touched } = installDb({
    request: { id: 'rr-1', token: TOKEN, customer_id: 'c-1', open_count: 0, status: 'sent', expires_at: new Date(Date.now() - 60_000).toISOString() },
  });
  await expect(ReviewService.getByToken(TOKEN)).resolves.toBeNull();
  expect(update).not.toHaveBeenCalled();
  expect(touched).toEqual(['review_requests']);
});

test('a live link (future expires_at) still stamps the open and reads the customer', async () => {
  const { update, touched } = installDb({
    request: { id: 'rr-1', token: TOKEN, customer_id: 'c-1', open_count: 0, status: 'sent', expires_at: new Date(Date.now() + 60_000).toISOString() },
  });
  const data = await ReviewService.getByToken(TOKEN);
  expect(data).not.toBeNull();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ open_count: 1 }));
  expect(touched).toContain('customers');
});
