// DELETE /api/admin/customers/:id/payment-methods/:methodId — staff removal
// rides the SAME removal path as the portal (services/payment-method-removal)
// with the Auto Pay guard forced on regardless of the portal gate, and audits
// only a removal that actually happened.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => ({ where: () => ({}) })));
const mockRemove = jest.fn();
const mockPreview = jest.fn();
jest.mock('../services/payment-method-removal', () => ({
  removePaymentMethod: (...a) => mockRemove(...a),
  removalPreview: (...a) => mockPreview(...a),
}));
const mockAudit = jest.fn().mockResolvedValue('audit-1');
jest.mock('../services/audit-log', () => ({ ...jest.requireActual('../services/audit-log'), recordAuditEvent: (...a) => mockAudit(...a) }));

const { requireAdmin } = require('../middleware/admin-auth');
const router = require('../routes/admin-customers');

const layer = router.stack.find((l) => l.route?.path === '/:id/payment-methods/:methodId');
const handler = layer.route.stack.at(-1).handle;

const call = async () => {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({
    params: { id: 'cust-1', methodId: 'pm-spare' },
    technicianId: 'tech-admin',
    ip: '127.0.0.1',
    get: () => 'jest',
  }, res, next);
  return { res, next };
};

beforeEach(() => { mockRemove.mockReset(); mockPreview.mockReset(); mockAudit.mockClear(); });

test('is DELETE-only and admin-only', () => {
  expect(Object.keys(layer.route.methods)).toEqual(['delete']);
  expect(layer.route.stack[0].handle).toBe(requireAdmin);
});

test('removes through the shared path with the Auto Pay guard forced on, then audits the removed method', async () => {
  mockRemove.mockResolvedValue({
    status: 200,
    body: { success: true, message: 'Payment method removed' },
    removedMethod: { id: 'pm-spare', method_type: 'card', card_brand: 'VISA', last_four: '1881' },
  });
  const { res, next } = await call();
  expect(mockRemove).toHaveBeenCalledWith({ customerId: 'cust-1', methodId: 'pm-spare', guard: true, source: 'admin_delete' });
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Payment method removed' });
  expect(next).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    actor_id: 'tech-admin',
    action: 'customer.payment_method.remove',
    resource_id: 'cust-1',
    metadata: { paymentMethodId: 'pm-spare', methodType: 'card', brand: 'VISA', lastFour: '1881' },
  }));
});

test('the Auto Pay refusal passes through untouched and writes no removal audit', async () => {
  const body = { code: 'autopay_method_in_use', error: 'This payment method is currently used for Auto Pay.' };
  mockRemove.mockResolvedValue({ status: 409, body, removedMethod: null });
  const { res } = await call();
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(body);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a failed audit write never turns a completed removal into an error', async () => {
  mockRemove.mockResolvedValue({ status: 200, body: { success: true }, removedMethod: { id: 'pm-spare' } });
  mockAudit.mockRejectedValueOnce(new Error('audit down'));
  const { res, next } = await call();
  await new Promise((r) => setImmediate(r));
  expect(res.status).toHaveBeenCalledWith(200);
  expect(next).not.toHaveBeenCalled();
});

test('a Stripe detach failure goes to the error handler', async () => {
  mockRemove.mockRejectedValue(new Error('Could not remove the payment method — please try again.'));
  const { res, next } = await call();
  expect(next).toHaveBeenCalledWith(expect.any(Error));
  expect(res.json).not.toHaveBeenCalled();
});

describe('GET .../removal-preview', () => {
  const previewLayer = router.stack.find((l) => l.route?.path === '/:id/payment-methods/:methodId/removal-preview');
  const previewHandler = previewLayer.route.stack.at(-1).handle;
  const get = async () => {
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await previewHandler({ params: { id: 'cust-1', methodId: 'pm-1' } }, res, next);
    return { res, next };
  };

  test('is GET-only and admin-only', () => {
    expect(Object.keys(previewLayer.route.methods)).toEqual(['get']);
    expect(previewLayer.route.stack[0].handle).toBe(requireAdmin);
  });

  test('returns the hold facts for this customer\'s method; another customer\'s method is 404', async () => {
    const preview = { holdsAppointment: { start: '2026-10-08T13:00:00.000Z', serviceType: 'Pest Control', feeAmount: 49 }, holdLookupFailed: false };
    mockPreview.mockResolvedValueOnce(preview);
    const { res } = await get();
    expect(mockPreview).toHaveBeenCalledWith({ customerId: 'cust-1', methodId: 'pm-1' });
    expect(res.json).toHaveBeenCalledWith(preview);

    mockPreview.mockResolvedValueOnce(null);
    const missing = await get();
    expect(missing.res.status).toHaveBeenCalledWith(404);
  });
});
