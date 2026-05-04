process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { generateToken, generateRefreshToken } = require('../middleware/auth');

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
});
