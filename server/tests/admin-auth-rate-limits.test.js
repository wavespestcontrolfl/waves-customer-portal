jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'rate-limit-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn() }));
jest.mock('../services/staff-password-reset-email', () => ({
  RESET_LINK_TTL_MINUTES: 30,
  sendStaffPasswordResetEmail: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: function adminAuthenticate(_req, _res, next) { next(); },
  requireAdmin: function requireAdmin(_req, _res, next) { next(); },
}));
jest.mock('express-rate-limit', () => jest.fn((options) => {
  const middleware = function testRateLimiter(_req, _res, next) { next(); };
  middleware.options = options;
  return middleware;
}));

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { adminAuthenticate } = require('../middleware/admin-auth');
const router = require('../routes/admin-auth');

describe('Staff auth route rate limits', () => {
  test('uses IP-only buckets for public reset routes and a versioned Staff bucket for change-password', () => {
    expect(rateLimit).toHaveBeenCalledTimes(3);
    const [requestOptions, resetOptions, changeOptions] = rateLimit.mock.calls.map(([options]) => options);

    expect(requestOptions.max).toBe(5);
    expect(resetOptions.max).toBe(10);
    expect(changeOptions.max).toBe(10);
    expect(changeOptions.windowMs).toBe(15 * 60 * 1000);

    const publicRequest = {
      ip: '2001:db8:abcd:12::99',
      headers: {
        authorization: `Bearer ${jwt.sign({ customerId: 'customer-1' }, 'rate-limit-secret')}`,
      },
    };
    expect(requestOptions.keyGenerator(publicRequest)).toBe('2001:db8:abcd:12::/64');
    expect(resetOptions.keyGenerator(publicRequest)).toBe('2001:db8:abcd:12::/64');

    const staffRequest = {
      ip: '203.0.113.9',
      headers: {
        authorization: `Bearer ${jwt.sign({
          technicianId: 'tech-1',
          type: 'access',
          tokenVersion: 7,
        }, 'rate-limit-secret')}`,
      },
    };
    expect(changeOptions.keyGenerator(staffRequest)).toBe('tech:tech-1:v7');
  });

  test('runs database-backed Staff authentication before the password-attempt limiter', () => {
    const route = router.stack.find((layer) => layer.route?.path === '/change-password');
    const handlers = route.route.stack.map((layer) => layer.handle);
    const changeLimiter = rateLimit.mock.results[2].value;

    expect(handlers[0]).toBe(adminAuthenticate);
    expect(handlers[1]).toBe(changeLimiter);
    expect(handlers[2].name).toBe('changePassword');
  });
});
