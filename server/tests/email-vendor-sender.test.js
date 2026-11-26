/**
 * isVendorWeUse — the one check behind "keep promos from every vendor we use"
 * (owner 2026-11-25). The fixed list needs no query; everything else is one
 * vendor_email_domains lookup and one LIMIT 1 lookup in emails.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { isVendorWeUse, registrableSenderDomain } = require('../services/email/vendor-sender');

// A knex-ish chain that records its calls and answers .first() per table.
function mockTables({ vendorDomain = null, priorEmail = null } = {}) {
  const calls = { emails: [], vendor_email_domains: [] };
  db.mockImplementation((table) => {
    const answer = table === 'vendor_email_domains' ? vendorDomain : priorEmail;
    const chain = {};
    for (const m of ['whereRaw', 'where', 'whereIn', 'orWhere', 'whereNot']) {
      chain[m] = jest.fn((...args) => {
        calls[table].push([m, ...args]);
        if ((m === 'where' || m === 'orWhere') && typeof args[0] === 'function') args[0](chain);
        return chain;
      });
    }
    chain.first = jest.fn(async () => answer);
    return chain;
  });
  return calls;
}

beforeEach(() => db.mockReset());

describe('registrableSenderDomain', () => {
  test.each([
    ['news@mail.anthropic.com', 'anthropic.com'],
    ['Claude <hello@email.claude.com>', 'claude.com'],
    ['Shop@Deals.Example.CO.UK', 'example.co.uk'],
    ['"billing@trusted.example" <promo@other.example>', 'other.example'],
    ['nobody', null],
    ['x@localhost', null],
  ])('%s -> %s', (from, expected) => {
    expect(registrableSenderDomain(from)).toBe(expected);
  });
});

describe('isVendorWeUse', () => {
  test.each([
    'news@anthropic.com', 'hi@mail.anthropic.com', 'a@email.claude.com', 'noreply@tm.openai.com', 'x@grow.siteone.com',
  ])('fixed-list vendor %s is a vendor with no query', async (from) => {
    expect(await isVendorWeUse({ id: 1, from_address: from })).toBe(true);
    expect(db).not.toHaveBeenCalled();
  });

  test('look-alikes of the fixed list are not vendors', async () => {
    mockTables();
    for (const from of ['x@anthropic.com.evil.example', 'x@notopenai.com', 'x@siteone.co']) {
      expect(await isVendorWeUse({ id: 1, from_address: from })).toBe(false);
    }
  });

  test('the vendor registry matches the exact mailbox, the domain and its parents, or a listed subdomain', async () => {
    const calls = mockTables({ vendorDomain: { id: 'v1' } });
    expect(await isVendorWeUse({ id: 1, from_address: 'Promo <promo@news.supplier.example>' })).toBe(true);
    expect(calls.vendor_email_domains).toContainEqual(['whereIn', 'domain', ['promo@news.supplier.example', 'news.supplier.example', 'supplier.example']]);
    expect(calls.vendor_email_domains).toContainEqual(['where', 'domain', 'like', '%.supplier.example']);
    // Only domain-only rows match by suffix: merchant@billing.example never vouches for a sibling.
    expect(calls.vendor_email_domains).toContainEqual(['whereNot', 'domain', 'like', '%@%']);
    expect(calls.emails).toHaveLength(0);
  });

  test('a per-company billing mailbox in the registry counts (siteoneus@billtrust.com shape)', async () => {
    const calls = mockTables({ vendorDomain: { id: 'v2' } });
    expect(await isVendorWeUse({ id: 1, from_address: 'billing-co@billing.example' })).toBe(true);
    expect(calls.vendor_email_domains[1][2]).toContain('billing-co@billing.example');
  });

  test('an earlier vendor row in emails matches, and the email itself is left out', async () => {
    const calls = mockTables({ priorEmail: { id: 'e0' } });
    expect(await isVendorWeUse({ id: 'e9', from_address: 'Promo <promo@news.supplier.example>' })).toBe(true);
    expect(calls.emails[0][2]).toEqual(['%@supplier.example', '%@supplier.example>', '%.supplier.example', '%.supplier.example>']);
    expect(calls.emails).toContainEqual(['whereIn', 'classification', ['vendor_invoice', 'vendor_communication']]);
    expect(calls.emails).toContainEqual(['orWhere', 'auto_action', 'like', 'expense\\_%']);
    expect(calls.emails).toContainEqual(['orWhere', 'auto_action', 'like', 'invoice\\_%']);
    expect(calls.emails).toContainEqual(['whereNot', 'id', 'e9']);
  });

  test('on a shared provider only the same mailbox counts, in the registry and in history', async () => {
    const calls = mockTables({ priorEmail: { id: 'e0' } });
    expect(await isVendorWeUse({ id: 'e9', from_address: 'Seller <seller@gmail.com>' })).toBe(true);
    expect(calls.vendor_email_domains).toContainEqual(['whereIn', 'domain', ['seller@gmail.com']]);
    expect(calls.vendor_email_domains.some((c) => c[0] === 'orWhere')).toBe(false);
    expect(calls.emails[0]).toEqual(['whereRaw', 'lower(from_address) = ?', ['seller@gmail.com']]);
  });

  test('strict mode (spam block) needs a booked expense from the same mailbox, never the whole domain', async () => {
    const calls = mockTables({ priorEmail: { id: 'e0' } });
    expect(await isVendorWeUse({ id: 'e9', from_address: 'merchant-a@billing.example' }, { strict: true })).toBe(true);
    expect(calls.emails[0]).toEqual(['whereRaw', 'lower(from_address) = ?', ['merchant-a@billing.example']]);
    expect(calls.emails).toContainEqual(['where', 'auto_action', 'like', 'expense\\_%']);
    // A deleted expense leaves the marker behind; only a live expense row counts.
    expect(calls.emails).toContainEqual(['whereRaw', 'EXISTS (SELECT 1 FROM expenses WHERE expenses.id = emails.expense_id)']);
    expect(calls.emails.some((c) => c[0] === 'whereIn' || c[0] === 'orWhere')).toBe(false);
  });

  test('a display name holding an address never replaces the bracketed mailbox', async () => {
    const calls = mockTables({ vendorDomain: null, priorEmail: null });
    await isVendorWeUse({ id: 1, from_address: '"seller@gmail.com" <spam@junk.example>' });
    expect(calls.vendor_email_domains[1][2]).toEqual(['spam@junk.example', 'junk.example']);
  });

  test('a billing platform is mailbox-scoped: one merchant never vouches for a sibling', async () => {
    const calls = mockTables({ priorEmail: null });
    expect(await isVendorWeUse({ id: 2, from_address: 'other-merchant@billtrust.com' })).toBe(false);
    expect(calls.vendor_email_domains).toContainEqual(['whereIn', 'domain', ['other-merchant@billtrust.com']]);
    expect(calls.emails[0][2]).toEqual(['other-merchant@billtrust.com']);
  });

  test('strict mode rethrows a failed lookup so the deferred block retries', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    db.mockImplementation(() => { const e = new Error('select … where domain in (deals@retailer.example.com)'); e.code = '57014'; throw e; });
    const err = await isVendorWeUse({ id: 7, from_address: 'deals@retailer.example.com' }, { strict: true }).catch((e) => e);
    expect(err.message).toBe('vendor lookup failed (email 7, code 57014)');
    expect(err.message).not.toContain('@');
  });

  test('a sender with no vendor history is not a vendor', async () => {
    mockTables();
    expect(await isVendorWeUse({ id: 1, from_address: 'deals@retailer.example.com' })).toBe(false);
  });

  test('a failed lookup keeps the sender (the safe side)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await isVendorWeUse({ id: 1, from_address: 'deals@retailer.example.com' })).toBe(true);
  });
});
