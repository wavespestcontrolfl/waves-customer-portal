jest.mock('googleapis', () => ({
  google: { gmail: jest.fn(() => ({ users: { settings: { filters: { delete: jest.fn(async () => ({})) } } } })) },
}));
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
        const chain = { whereNull: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
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
        const chain = { whereNull: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
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

  const mockTables = ({ del, blockRow = {}, syncTrashed = [] }) => {
    db.mockImplementation((table) => {
      if (table === 'blocked_email_senders') {
        const chain = {
          where: jest.fn(() => chain),
          whereRaw: jest.fn(() => chain),
          first: jest.fn(async () => ({ id: 'b1', reason: 'spam_auto', email_address: 'cust@x.example', gmail_filter_id: 'f-1', created_at: '2026-07-01T00:00:00Z', ...blockRow })),
          del,
        };
        return chain;
      }
      if (table === 'emails') {
        const chain = { where: jest.fn(() => chain), whereRaw: jest.fn(() => chain), select: jest.fn(async () => syncTrashed) };
        return chain;
      }
      if (table === 'customers') {
        const chain = { whereNull: jest.fn(() => chain), first: jest.fn(async () => ({ id: 'c1' })) };
        return { whereRaw: jest.fn(() => chain) };
      }
      if (table === 'leads') {
        const chain = { whereNull: jest.fn(() => chain), where: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
      }
      throw new Error(`unexpected table ${table}`);
    });
  };

  beforeEach(() => jest.clearAllMocks());

  test('successful removal recovers ALL block-buried mail, then deletes the row', async () => {
    const del = jest.fn(async () => 1);
    mockTables({ del, syncTrashed: [{ gmail_id: 'm-db-1' }] });
    gmailClient.getAuthClient.mockResolvedValueOnce({});
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'm-old-1' }, { id: 'm-old-2' }], truncated: false });
    gmailClient.getMessageLabels.mockResolvedValue(['TRASH']);

    await expect(isBlocked('cust@x.example', { gmailId: 'm-trigger' })).resolves.toBe(false);
    // Search is SCOPED to the block's lifetime — nothing older can be its burial.
    expect(gmailClient.listAllMessages.mock.calls[0][0]).toMatch(/^in:trash from:cust@x\.example after:\d+$/);
    // Recovery covers sync-trashed rows AND filter burials, not just the trigger.
    expect(gmailClient.modifyLabels.mock.calls.map((c) => c[0]).sort())
      .toEqual(['m-db-1', 'm-old-1', 'm-old-2', 'm-trigger']);
    expect(del).toHaveBeenCalled();
  });

  test('a filterless block never bulk-searches Trash — only recorded burials recover', async () => {
    const del = jest.fn(async () => 1);
    mockTables({ del, blockRow: { gmail_filter_id: null }, syncTrashed: [{ gmail_id: 'm-db-1' }] });
    gmailClient.getMessageLabels.mockResolvedValue(['TRASH']);

    await expect(isBlocked('cust@x.example', { gmailId: 'm-trigger' })).resolves.toBe(false);
    // No filter ever existed — an unscoped search would resurrect
    // operator-deleted mail unrelated to the block.
    expect(gmailClient.listAllMessages).not.toHaveBeenCalled();
    expect(gmailClient.modifyLabels.mock.calls.map((c) => c[0]).sort()).toEqual(['m-db-1', 'm-trigger']);
    expect(del).toHaveBeenCalled();
  });

  test('recovery failure keeps the block row as the retry token', async () => {
    const del = jest.fn(async () => 1);
    mockTables({ del });
    gmailClient.getAuthClient.mockResolvedValueOnce({});
    gmailClient.listAllMessages.mockRejectedValueOnce(new Error('gmail down'));

    // Identity still wins for THIS message's classification…
    await expect(isBlocked('cust@x.example', { gmailId: 'm-trigger' })).resolves.toBe(false);
    // …but the row survives so the next message (or the daily reconcile)
    // re-runs the full recovery instead of stranding buried mail.
    expect(del).not.toHaveBeenCalled();
  });

  test('a truncated Trash search recovers a page but KEEPS the row for the next pass', async () => {
    const del = jest.fn(async () => 1);
    mockTables({ del });
    gmailClient.getAuthClient.mockResolvedValueOnce({});
    gmailClient.listAllMessages.mockResolvedValueOnce({ messages: [{ id: 'm-1' }, { id: 'm-2' }], truncated: true });
    gmailClient.getMessageLabels.mockResolvedValue(['TRASH']);

    await expect(isBlocked('cust@x.example', { gmailId: 'm-trigger' })).resolves.toBe(false);
    // This page was recovered…
    expect(gmailClient.modifyLabels).toHaveBeenCalled();
    // …but the retry token stays until a non-truncated pass drains Trash.
    expect(del).not.toHaveBeenCalled();
  });

  test('a soft-deleted customer is NOT a protected identity — the block stays enforced', async () => {
    const del = jest.fn(async () => 1);
    const increment = jest.fn(async () => {});
    db.mockImplementation((table) => {
      if (table === 'blocked_email_senders') {
        const chain = {
          where: jest.fn((arg) => {
            if (arg && arg.id === 'b1') return { increment, del };
            return chain;
          }),
          whereRaw: jest.fn(() => chain),
          first: jest.fn(async () => ({ id: 'b1', reason: 'spam_auto', email_address: 'cust@x.example', gmail_filter_id: null })),
          del,
        };
        return chain;
      }
      if (table === 'customers') {
        // whereNull('deleted_at') filters the soft-deleted row out.
        const chain = { whereNull: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
      }
      if (table === 'leads') {
        const chain = { whereNull: jest.fn(() => chain), where: jest.fn(() => chain), first: jest.fn(async () => null) };
        return { whereRaw: jest.fn(() => chain) };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(isBlocked('cust@x.example', { gmailId: 'm-x' })).resolves.toBe(true);
    expect(del).not.toHaveBeenCalled();
    expect(increment).toHaveBeenCalledWith('blocked_count', 1);
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
      if (table === 'emails') {
        const chain = { where: jest.fn(() => chain), whereRaw: jest.fn(() => chain), select: jest.fn(async () => []) };
        return chain;
      }
      if (table === 'customers') {
        return { whereRaw: jest.fn((sql, [addr]) => {
          const chain = { whereNull: jest.fn(() => chain), first: jest.fn(async () => (addr === 'cust@x.example' ? { id: 'c1' } : null)) };
          return chain;
        }) };
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
