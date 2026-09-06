jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'test-only' } }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: jest.fn() }));
jest.mock('../services/discount-engine', () => ({ applyPromoCode: jest.fn() }));
jest.mock('../services/logger', () => ({}));
jest.mock('../services/audit-log', () => ({}));

const db = require('../models/db');
const jwt = require('jsonwebtoken');
const engine = require('../services/discount-engine');
const router = require('../routes/admin-discounts');

function applyPromo(role) {
  db.mockImplementation(() => ({
    where: () => ({ first: async () => ({ id: 'test-staff', role, employment_status: 'active', auth_token_version: 1 }) }),
  }));
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST', url: '/promo-validate',
      headers: { authorization: 'Bearer test-token' },
      body: { customerId: 'test-customer', code: 'TEST' },
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    router.handle(req, res, reject);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ type: 'access', technicianId: 'test-staff', tokenVersion: 1 });
  engine.applyPromoCode.mockResolvedValue({ success: true });
});

test('a technician cannot consume a promo or assign it to a customer', async () => {
  expect(await applyPromo('technician')).toEqual({ status: 403, body: { error: 'Admin access required' } });
  expect(engine.applyPromoCode).not.toHaveBeenCalled();
});

test('an admin retains the existing promo application contract', async () => {
  expect(await applyPromo('admin')).toEqual({ status: 200, body: { success: true } });
  expect(engine.applyPromoCode).toHaveBeenCalledTimes(1);
  expect(engine.applyPromoCode).toHaveBeenCalledWith('test-customer', 'TEST');
});
