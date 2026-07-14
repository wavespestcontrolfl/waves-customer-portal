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

describe('Stripe Terminal saved-card fence response', () => {
  test('distinguishes a retryable active claim from reconciliation', () => {
    expect(_test.terminalChargeFenceResponse({
      code: 'STRIPE_CHARGE_IN_PROGRESS',
      reconciliationRequired: false,
    })).toEqual(expect.objectContaining({
      code: 'payment_charge_in_progress',
      reconciliationRequired: false,
    }));
    expect(_test.terminalChargeFenceResponse({
      code: 'STRIPE_AMBIGUOUS_OUTCOME',
      reconciliationRequired: true,
    })).toEqual(expect.objectContaining({
      code: 'payment_reconciliation_pending',
      reconciliationRequired: true,
    }));
  });
});

describe('Stripe Terminal canceled-handoff recovery', () => {
  test('only the explicit expires-at-used-at marker forces a fresh handoff', () => {
    const usedAt = '2026-07-15T23:00:00.000Z';
    expect(_test.terminalHandoffNeedsReissue({
      used_at: usedAt,
      expires_at: usedAt,
    })).toBe(true);
    expect(_test.terminalHandoffNeedsReissue({
      used_at: usedAt,
      expires_at: '2026-07-15T23:01:00.000Z',
    })).toBe(false);
    expect(_test.terminalHandoffNeedsReissue({
      used_at: null,
      expires_at: usedAt,
    })).toBe(false);
  });
});
