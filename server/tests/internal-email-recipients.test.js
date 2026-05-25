const {
  assertInternalEmailRecipient,
  isInternalEmailRecipient,
} = require('../utils/internal-email-recipients');

describe('internal email recipient guardrails', () => {
  const savedEnv = {
    INTERNAL_EMAIL_DOMAINS: process.env.INTERNAL_EMAIL_DOMAINS,
    INTERNAL_EMAIL_ALLOWLIST: process.env.INTERNAL_EMAIL_ALLOWLIST,
    ADMIN_EMAIL_ALLOWLIST: process.env.ADMIN_EMAIL_ALLOWLIST,
    INTERNAL_TEST_EMAIL_ALLOWLIST: process.env.INTERNAL_TEST_EMAIL_ALLOWLIST,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('allows Waves-owned addresses and the logged-in admin email', () => {
    expect(isInternalEmailRecipient('newsletter@wavespestcontrol.com')).toBe(true);
    expect(isInternalEmailRecipient('owner@example.com', { adminEmail: 'owner@example.com' })).toBe(true);
    expect(assertInternalEmailRecipient(
      'Owner@Example.com',
      { adminEmail: 'owner@example.com' },
    )).toBe('owner@example.com');
  });

  test('blocks customer-looking recipients for admin test sends', () => {
    expect(isInternalEmailRecipient('customer@gmail.com')).toBe(false);
    expect(() => assertInternalEmailRecipient('customer@gmail.com', {
      adminEmail: 'owner@example.com',
    })).toThrow('test email recipient must be an internal/admin address');
  });

  test('supports explicit env allowlists for non-domain admin inboxes', () => {
    process.env.INTERNAL_TEST_EMAIL_ALLOWLIST = 'ops@example.net';

    expect(assertInternalEmailRecipient('ops@example.net')).toBe('ops@example.net');
  });

  test('rejects malformed addresses before allowlist checks', () => {
    expect(() => assertInternalEmailRecipient('not-an-email')).toThrow('valid internal toEmail required');
  });
});
