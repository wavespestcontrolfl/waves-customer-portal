process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const { authenticate, generateToken, generateRefreshToken } = require('../middleware/auth');

describe('customer auth tokens', () => {
  test('access tokens carry selected property and owning account separately', () => {
    const token = generateToken('property-123', 'account-456');
    const decoded = jwt.verify(token, config.jwt.secret);

    expect(decoded.customerId).toBe('property-123');
    expect(decoded.accountId).toBe('account-456');
  });

  test('refresh tokens preserve the account claim for property switching', () => {
    const token = generateRefreshToken('property-789', 'account-456');
    const decoded = jwt.verify(token, config.jwt.secret);

    expect(decoded.customerId).toBe('property-789');
    expect(decoded.accountId).toBe('account-456');
    expect(decoded.type).toBe('refresh');
  });

  test('authenticate rejects a selected property with a stale account claim', async () => {
    const token = generateToken('property-123', 'old-account');
    const query = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'property-123',
        active: true,
        account_id: 'new-account',
      }),
    };
    db.mockReturnValueOnce(query);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token account' });
    expect(next).not.toHaveBeenCalled();
  });
});
