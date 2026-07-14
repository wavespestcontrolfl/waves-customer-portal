jest.mock('../config', () => ({ jwt: { secret: 'rate-limit-secret' } }));

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  rateLimitKey,
  unauthenticatedAuthLimitKey,
} = require('../middleware/rate-limit-key');

function requestFor(claims, ip = '203.0.113.9') {
  return {
    ip,
    headers: {
      authorization: `Bearer ${jwt.sign(claims, 'rate-limit-secret')}`,
    },
  };
}

describe('staff rate-limit identity keys', () => {
  test('includes the positive credential version for a staff access token', () => {
    expect(rateLimitKey(requestFor({
      technicianId: 'tech-1',
      type: 'access',
      tokenVersion: 3,
    }))).toBe('tech:tech-1:v3');
  });

  test.each([
    [{ technicianId: 'tech-1', type: 'access', tokenVersion: 0 }],
    [{ technicianId: 'tech-1', type: 'access' }],
    [{ technicianId: 'tech-1', type: 'refresh', tokenVersion: 3 }],
  ])('falls back to IP for a non-current staff token shape', (claims) => {
    expect(rateLimitKey(requestFor(claims))).toBe('203.0.113.9');
  });

  test('preserves the existing customer subject key', () => {
    expect(rateLimitKey(requestFor({ customerId: 'customer-1' })))
      .toBe('cust:customer-1');
  });

  test('unauthenticated auth limits ignore attached JWTs and collapse IPv6 by /64', () => {
    const first = requestFor({
      technicianId: 'tech-1',
      type: 'access',
      tokenVersion: 3,
    }, '2001:db8:abcd:12::1');
    const second = requestFor({ customerId: 'customer-1' }, '2001:0db8:abcd:0012::ffff');

    expect(unauthenticatedAuthLimitKey(first)).toBe('2001:db8:abcd:12::/64');
    expect(unauthenticatedAuthLimitKey(second)).toBe('2001:db8:abcd:12::/64');
  });

  test('the pre-parser login limiter uses the unauthenticated /64 key', () => {
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const limiterBlock = source.match(
      /const authLimiter = rateLimit\([\s\S]*?\n}\);/,
    )?.[0];

    expect(limiterBlock).toMatch(/keyGenerator: unauthenticatedAuthLimitKey/);
    expect(limiterBlock).not.toMatch(/keyGenerator: rateLimitKey/);
  });
});
