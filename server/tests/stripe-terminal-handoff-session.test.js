jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'staff-jwt-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_placeholder' }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/audit-log', () => ({
  auditTerminalHandoffMint: jest.fn(),
  auditTerminalHandoffRateLimited: jest.fn(),
  auditTerminalHandoffValidate: jest.fn(),
  ipFromReq: jest.fn(),
  uaFromReq: jest.fn(),
}));

const { _test } = require('../routes/stripe-terminal');

describe('Stripe Terminal handoff staff-session binding', () => {
  const activeTech = {
    id: 'tech-1',
    active: true,
    role: 'technician',
    must_change_password: false,
    auth_token_version: 8,
  };

  test('a handoff minted before credential rotation no longer matches', () => {
    expect(_test.handoffStaffSessionMatches({ staff_token_version: 7 }, activeTech)).toBe(false);
    expect(_test.handoffStaffSessionMatches({ staff_token_version: 8 }, activeTech)).toBe(true);
  });

  test.each([
    [{}, activeTech],
    [{ staff_token_version: 0 }, { ...activeTech, auth_token_version: 0 }],
    [{ staff_token_version: 1 }, { ...activeTech, auth_token_version: 0 }],
    [{ staff_token_version: 8 }, { ...activeTech, role: 'viewer' }],
    [{ staff_token_version: 8 }, { ...activeTech, must_change_password: true }],
    [{ staff_token_version: 8 }, { ...activeTech, active: false }],
  ])('fails closed for an invalid staff authorization boundary', (claims, tech) => {
    expect(_test.handoffStaffSessionMatches(claims, tech)).toBe(false);
  });
});
