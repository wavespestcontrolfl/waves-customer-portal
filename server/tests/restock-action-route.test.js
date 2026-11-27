// POST /admin/inventory/restock-requests/:id/action: the receive warning's 409 body, the confirm
// flag (receive only) and the close_counted action reach the shared domain unchanged.
let mockRole = 'admin';
jest.mock('../services/procurement/order-dispatch', () => ({ tryAgainParkedRequest: jest.fn() }));
jest.mock('../models/db', () => Object.assign(jest.fn(), { schema: { hasTable: jest.fn().mockResolvedValue(true) } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/inventory-operations', () => ({ updateRestockRequest: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = mockRole; next(); } };
});

const express = require('express');
const { updateRestockRequest } = require('../services/inventory-operations');
const { tryAgainParkedRequest } = require('../services/procurement/order-dispatch');
const router = require('../routes/admin-inventory');

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';

async function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/inventory/restock-requests/${REQUEST_ID}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeEach(() => { updateRestockRequest.mockReset(); tryAgainParkedRequest.mockReset(); mockRole = 'admin'; });

test('a receive an invoice already counted comes back 409 with its code and the amount added', async () => {
  updateRestockRequest.mockRejectedValue(Object.assign(new Error('An invoice already added 4 gal on November 24. Receive again only if this is a second delivery.'),
    { statusCode: 409, code: 'already_counted_by_receipt', details: { receiptFingerprint: 'fp-1', alreadyAdded: [{ quantity: 4, unit: 'gal', addedAt: '2026-11-24T15:00:00.000Z' }] } }));
  const res = await post({ action: 'receive' });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({
    error: 'An invoice already added 4 gal on November 24. Receive again only if this is a second delivery.',
    code: 'already_counted_by_receipt', receiptFingerprint: 'fp-1', alreadyAdded: [{ quantity: 4, unit: 'gal', addedAt: '2026-11-24T15:00:00.000Z' }],
  });
  expect(updateRestockRequest).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({ action: 'receive', confirm: false }), expect.any(Object));
});

test('Receive anyway sends confirm only when it is exactly true', async () => {
  updateRestockRequest.mockResolvedValue({ request: { id: REQUEST_ID, status: 'received' } });
  await post({ action: 'receive', confirm: true, confirmFingerprint: 'fp-1' });
  expect(updateRestockRequest.mock.calls[0][1]).toMatchObject({ action: 'receive', confirm: true, confirmFingerprint: 'fp-1' });
  await post({ action: 'receive', confirm: 'yes' });
  expect(updateRestockRequest.mock.calls[1][1]).toMatchObject({ confirm: false });
});

test('close_counted passes through without quantity, unit or confirm', async () => {
  updateRestockRequest.mockResolvedValue({ request: { id: REQUEST_ID, status: 'received' } });
  const res = await post({ action: 'close_counted', quantity: 5, unit: 'gal', confirm: true, note: 'invoice counted it' });
  expect(res.status).toBe(200);
  expect(updateRestockRequest).toHaveBeenCalledWith(REQUEST_ID, { action: 'close_counted', note: 'invoice counted it' }, expect.any(Object));
});

test('Close, already counted from the warning dialog passes its fingerprint; receive-only fields stay out', async () => {
  updateRestockRequest.mockResolvedValue({ request: { id: REQUEST_ID, status: 'received' } });
  await post({ action: 'close_counted', confirm: true, confirmFingerprint: 'fp-1' });
  expect(updateRestockRequest).toHaveBeenCalledWith(REQUEST_ID, { action: 'close_counted', note: undefined, confirmFingerprint: 'fp-1' }, expect.any(Object));
});

test('try_again is the owner\'s: it queues the parked request through the dispatcher, never through the status writer', async () => {
  tryAgainParkedRequest.mockResolvedValue({ ledgerId: 'l1' });
  const res = await post({ action: 'try_again' });
  expect(res).toEqual({ status: 200, body: { success: true, queued: true } });
  expect(tryAgainParkedRequest).toHaveBeenCalledWith(REQUEST_ID, { actorId: 'staff-1' });
  expect(updateRestockRequest).not.toHaveBeenCalled();
});

test('try_again from a technician is refused 403 and queues nothing', async () => {
  mockRole = 'technician';
  const res = await post({ action: 'try_again' });
  expect(res.status).toBe(403);
  expect(tryAgainParkedRequest).not.toHaveBeenCalled();
});

test('a refusal from the dispatcher (not parked, order may be out) comes back 409 with its code', async () => {
  tryAgainParkedRequest.mockRejectedValue(Object.assign(new Error('An automatic order may already have gone out.'), { statusCode: 409, code: 'auto_order_out' }));
  const res = await post({ action: 'try_again' });
  expect(res).toEqual({ status: 409, body: { error: 'An automatic order may already have gone out.', code: 'auto_order_out' } });
});
