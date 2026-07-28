jest.mock('googleapis', () => ({ google: {} }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/email/gmail-client', () => ({
  getAuthClient: jest.fn(async () => null),
  listAllMessages: jest.fn(async () => ({ messages: [], truncated: false })),
  getMessageLabels: jest.fn(async () => []),
  modifyLabels: jest.fn(async () => {}),
}));
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
      if (table === 'customers') {
        return { whereRaw: jest.fn(() => ({ first: jest.fn(async () => null) })) };
      }
      if (table === 'leads') {
        const chain = { whereNull: jest.fn(() => chain), where: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
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
        return { whereRaw: jest.fn(() => ({ first: jest.fn(async () => null) })) };
      }
      if (table === 'leads') {
        const chain = { whereNull: jest.fn(() => chain), where: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
      }
      if (table === 'vendor_email_domains') {
        return { where: jest.fn(() => ({ first: jest.fn(async () => ({ domain: 'vendor.example' })) })) };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(isBlocked('rep@vendor.example')).resolves.toBe(false);
  });
});

describe('stale auto-block removal (sender became a customer)', () => {
  const gmailClient = require('../services/email/gmail-client');

  const mockTables = ({ del }) => {
    db.mockImplementation((table) => {
      if (table === 'blocked_email_senders') {
        const chain = {
          where: jest.fn(() => chain),
          whereRaw: jest.fn(() => chain),
          first: jest.fn(async () => ({ id: 'b1', reason: 'spam_auto', email_address: 'cust@x.example', gmail_filter_id: null })),
          del,
        };
        return chain;
      }
      if (table === 'customers') {
        return { whereRaw: jest.fn(() => ({ first: jest.fn(async () => ({ id: 'c1' })) })) };
      }
      if (table === 'leads') {
        const chain = { whereNull: jest.fn(() => chain), where: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
      }
      throw new Error(`unexpected table ${table}`);
    });
  };

  beforeEach(() => jest.clearAllMocks());

  test('successful removal recovers ALL buried mail, then deletes the row', async () => {
    const del = jest.fn(async () => 1);
    mockTables({ del });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'm-old-1' }, { id: 'm-old-2' }], truncated: false });
    gmailClient.getMessageLabels.mockResolvedValue(['TRASH']);

    await expect(isBlocked('cust@x.example', { gmailId: 'm-trigger' })).resolves.toBe(false);
    // The Trash search covers earlier burials, not just the triggering message.
    expect(gmailClient.modifyLabels.mock.calls.map((c) => c[0]).sort())
      .toEqual(['m-old-1', 'm-old-2', 'm-trigger']);
    expect(gmailClient.modifyLabels).toHaveBeenCalledWith('m-old-1', ['INBOX'], ['TRASH']);
    expect(del).toHaveBeenCalled();
  });

  test('recovery failure keeps the block row as the retry token', async () => {
    const del = jest.fn(async () => 1);
    mockTables({ del });
    gmailClient.listAllMessages.mockRejectedValueOnce(new Error('gmail down'));

    // Identity still wins for THIS message's classification…
    await expect(isBlocked('cust@x.example', { gmailId: 'm-trigger' })).resolves.toBe(false);
    // …but the row survives so the next message (or the daily reconcile)
    // re-runs the full recovery instead of stranding buried mail.
    expect(del).not.toHaveBeenCalled();
  });

  test('reconcileStaleAutoBlocks unwinds blocks for now-protected senders without waiting for new mail', async () => {
    const { reconcileStaleAutoBlocks } = require('../services/email/spam-blocker');
    const del = jest.fn(async () => 1);
    db.mockImplementation((table) => {
      if (table === 'blocked_email_senders') {
        const chain = {
          where: jest.fn(() => chain),
          whereRaw: jest.fn(() => chain),
          select: jest.fn(async () => [
            { id: 'b1', email_address: 'cust@x.example' },
            { id: 'b2', email_address: 'stranger@junk.example' },
          ]),
          first: jest.fn(async () => ({ id: 'b1', reason: 'spam_auto', email_address: 'cust@x.example', gmail_filter_id: null })),
          del,
        };
        return chain;
      }
      if (table === 'customers') {
        return { whereRaw: jest.fn((sql, [addr]) => ({ first: jest.fn(async () => (addr === 'cust@x.example' ? { id: 'c1' } : null)) })) };
      }
      if (table === 'leads') {
        const chain = { whereNull: jest.fn(() => chain), where: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
      }
      throw new Error(`unexpected table ${table}`);
    });
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [], truncated: false });

    const counts = await reconcileStaleAutoBlocks();
    // Only the sender who became a customer is unwound; the stranger's
    // block (still legitimate) is untouched.
    expect(counts).toEqual({ reconciled: 1, failed: 0 });
    expect(del).toHaveBeenCalledTimes(1);
  });
});
