// Tap to Pay handoff scope (codex #5568 r1 P1): a technician mints a handoff
// only for an invoice whose customer is on their current/recent route; an
// admin is unscoped. /capture is admin-only (see the route).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'staff-jwt-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_placeholder' }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/audit-log', () => ({
  auditTerminalHandoffMint: jest.fn(), auditTerminalHandoffRateLimited: jest.fn(), auditTerminalHandoffValidate: jest.fn(), ipFromReq: jest.fn(), uaFromReq: jest.fn(),
}));
const mockServices = jest.fn(async () => false);
jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: (...a) => mockServices(...a) }));

const { _test } = require('../routes/stripe-terminal');

beforeEach(() => mockServices.mockReset().mockResolvedValue(false));

describe('technicianMayCollectInvoice', () => {
  test('an admin collects any invoice without a scope lookup', async () => {
    await expect(_test.technicianMayCollectInvoice({ techRole: 'admin' }, { id: 'inv', customer_id: 'c1' })).resolves.toBe(true);
    expect(mockServices).not.toHaveBeenCalled();
  });
  test('a technician collects only for a customer on their route', async () => {
    mockServices.mockResolvedValueOnce(true);
    await expect(_test.technicianMayCollectInvoice({ techRole: 'technician', technicianId: 't1' }, { id: 'inv', customer_id: 'c1' })).resolves.toBe(true);
    expect(mockServices).toHaveBeenCalledWith(expect.objectContaining({ technicianId: 't1' }), 'c1');
    await expect(_test.technicianMayCollectInvoice({ techRole: 'technician', technicianId: 't1' }, { id: 'inv', customer_id: 'c2' })).resolves.toBe(false);
  });
  test('an invoice with no customer is never collectible by a technician', async () => {
    await expect(_test.technicianMayCollectInvoice({ techRole: 'technician' }, { id: 'inv', customer_id: null })).resolves.toBe(false);
    expect(mockServices).not.toHaveBeenCalled();
  });
});
