jest.mock('googleapis', () => ({ google: {} }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const {
  domainFromAddress,
  isBlocked,
  isProtectedDomain,
  normalizeAddress,
} = require('../services/email/spam-blocker');

describe('email spam blocker safety helpers', () => {
  beforeEach(() => {
    db.mockReset();
  });

  test('normalizes addresses before matching block rules', () => {
    expect(normalizeAddress('  Customer.Name+Bug@Gmail.COM  ')).toBe('customer.name+bug@gmail.com');
    expect(domainFromAddress('Customer.Name+Bug@Gmail.COM')).toBe('gmail.com');
  });

  test('protects customer mailbox providers from domain-wide blocking', () => {
    expect(isProtectedDomain('gmail.com')).toBe(true);
    expect(isProtectedDomain('outlook.com')).toBe(true);
    expect(isProtectedDomain('yahoo.com')).toBe(true);
    expect(isProtectedDomain('comcast.net')).toBe(true);
    expect(isProtectedDomain('verizon.net')).toBe(true);
    expect(isProtectedDomain('att.net')).toBe(true);
  });

  test('protects Waves, Google, and operational platform domains', () => {
    expect(isProtectedDomain('wavespestcontrol.com')).toBe(true);
    expect(isProtectedDomain('mail.wavespestcontrol.com')).toBe(true);
    expect(isProtectedDomain('parrishpestcontrol.com')).toBe(true);
    expect(isProtectedDomain('google.com')).toBe(true);
    expect(isProtectedDomain('alerts.google.com')).toBe(true);
    expect(isProtectedDomain('mail.stripe.com')).toBe(true);
    expect(isProtectedDomain('business.facebook.com')).toBe(true);
    expect(isProtectedDomain('stripe.com')).toBe(true);
    expect(isProtectedDomain('twilio.com')).toBe(true);
  });

  test('does not protect ordinary solicitation domains', () => {
    expect(isProtectedDomain('example-seo-agency.test')).toBe(false);
  });

  test('honors exact sender blocks before vendor domain fail-open', async () => {
    const increment = jest.fn(async () => {});
    db.mockImplementation((table) => {
      if (table === 'blocked_email_senders') {
        return {
          where: jest.fn((arg) => {
            if (arg && arg.id === 'block-1') return { increment };
            return { first: jest.fn(async () => ({ id: 'block-1' })) };
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(isBlocked('Noisy.Person@Vendor.example')).resolves.toBe(true);
    expect(increment).toHaveBeenCalledWith('blocked_count', 1);
  });

  test('ignores broad domain blocks for vendor domains when no exact sender block exists', async () => {
    db.mockImplementation((table) => {
      if (table === 'blocked_email_senders') {
        return { where: jest.fn(() => ({ first: jest.fn(async () => null) })) };
      }
      if (table === 'customers') {
        return { where: jest.fn(() => ({ first: jest.fn(async () => null) })) };
      }
      if (table === 'vendor_email_domains') {
        return { where: jest.fn(() => ({ first: jest.fn(async () => ({ domain: 'vendor.example' })) })) };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(isBlocked('rep@vendor.example')).resolves.toBe(false);
  });
});
