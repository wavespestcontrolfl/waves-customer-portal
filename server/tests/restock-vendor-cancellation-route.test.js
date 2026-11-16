// The Restock tab's "Record vendor cancellation" route (daily-work audit
// 2026-11-06): POST /admin/inventory/restock-requests/:id/vendor-cancellation.
// It is owner-only, it needs the operator's explicit confirmation that the
// vendor cancelled, and it hands the order the tab showed to the shared revoke
// (services/procurement/order-revoke.js, covered by order-revoke-postgres).
//
// The role middlewares are the REAL ones; only adminAuthenticate is replaced
// so the test can pick the role.
let mockRole = 'admin';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/procurement/order-revoke', () => ({ recordVendorCancellation: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technicianId = 'staff-1';
      req.techRole = mockRole;
      next();
    },
  };
});

const express = require('express');
const { recordVendorCancellation } = require('../services/procurement/order-revoke');
const router = require('../routes/admin-inventory');

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const ORDER = { orderId: '66666666-7777-4888-9999-aaaaaaaaaaaa', version: '2026-11-06T15:00:00.000Z' };

async function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/inventory/restock-requests/${REQUEST_ID}/vendor-cancellation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeEach(() => {
  mockRole = 'admin';
  recordVendorCancellation.mockReset();
});

test('an admin who confirms records the cancellation of the order the tab showed', async () => {
  recordVendorCancellation.mockResolvedValue({ requestStatus: 'cancelled' });
  const res = await post({ ...ORDER, cancelledWithVendor: true });
  expect(res).toEqual({ status: 200, body: { success: true, requestStatus: 'cancelled' } });
  expect(recordVendorCancellation).toHaveBeenCalledTimes(1);
  expect(recordVendorCancellation).toHaveBeenCalledWith(REQUEST_ID, { ...ORDER, actorId: 'staff-1' });
});

test.each([
  ['no confirmation', {}],
  ['a confirmation that is not the boolean true', { cancelledWithVendor: 'true' }],
])('%s is a 400 and records nothing', async (_name, extra) => {
  const res = await post({ ...ORDER, ...extra });
  expect(res).toEqual({ status: 400, body: { error: 'Confirm that the vendor has cancelled this order first.', code: 'not_confirmed' } });
  expect(recordVendorCancellation).not.toHaveBeenCalled();
});

test('a technician gets 403 and records nothing', async () => {
  mockRole = 'technician';
  const res = await post({ ...ORDER, cancelledWithVendor: true });
  expect(res.status).toBe(403);
  expect(recordVendorCancellation).not.toHaveBeenCalled();
});

test('a refusal from the revoke keeps its status, message and code', async () => {
  recordVendorCancellation.mockRejectedValue(Object.assign(
    new Error('This order changed after the Restock tab loaded. Reload it and check the order again.'),
    { statusCode: 409, code: 'order_changed', isOperational: true },
  ));
  const res = await post({ ...ORDER, cancelledWithVendor: true });
  expect(res).toEqual({
    status: 409,
    body: { error: 'This order changed after the Restock tab loaded. Reload it and check the order again.', code: 'order_changed' },
  });
});
