const mockListPortalPayments = jest.fn();
jest.mock('../services/portal-payment-history', () => ({
  listPortalPayments: (...args) => mockListPortalPayments(...args),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({ authenticate: (_req, _res, next) => next() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));

const { isEnabled } = require('../config/feature-gates');
const router = require('../routes/billing-v2');

async function getHistory() {
  const layer = router.stack.find((entry) => entry.route?.path === '/');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { customerId: 'cust-1', query: {} };
  let body;
  let error;
  await handler(req, { json: (value) => { body = value; } }, (err) => { error = err; });
  if (error) throw error;
  return body;
}

beforeEach(() => {
  mockListPortalPayments.mockReset();
  isEnabled.mockReset();
  mockListPortalPayments.mockResolvedValue({ payments: [], payerLookupFailed: false });
});

test.each([
  [true, true],
  [false, false],
])('the signed-in Billing route follows the portalPayNow gate: %s', async (gateValue, expected) => {
  isEnabled.mockImplementation((name) => name === 'portalPayNow' && gateValue);

  await expect(getHistory()).resolves.toEqual({ payments: [] });
  expect(mockListPortalPayments).toHaveBeenCalledWith('cust-1', {
    limit: 50,
    cursor: 0,
    includeRecoveryInvoices: expected,
  });
});
