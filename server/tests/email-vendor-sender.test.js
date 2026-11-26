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
        if (m === 'where' && typeof args[0] === 'function') args[0](chain);
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

  test('a vendor_email_domains row matches the exact domain or a subdomain of the registrable domain', async () => {
    const calls = mockTables({ vendorDomain: { id: 'v1' } });
    expect(await isVendorWeUse({ id: 1, from_address: 'promo@news.supplier.example' })).toBe(true);
    expect(calls.vendor_email_domains[0]).toEqual(['whereRaw', '(domain = ? OR domain LIKE ?)', ['supplier.example', '%.supplier.example']]);
    expect(calls.emails).toHaveLength(0);
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

  test('strict mode (spam block) counts only money evidence, not a vendor_communication label', async () => {
    const calls = mockTables({ priorEmail: { id: 'e0' } });
    expect(await isVendorWeUse({ id: 'e9', from_address: 'promo@news.supplier.example' }, { strict: true })).toBe(true);
    expect(calls.emails).toContainEqual(['whereIn', 'classification', ['vendor_invoice']]);
    expect(calls.emails).toContainEqual(['orWhere', 'auto_action', 'like', 'expense\\_%']);
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
