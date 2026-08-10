process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// detectUnlinkedMemberAddress — the save-time unlinked-member guard
// (workstream-1 hardening, 2026-08-10). Warns when the typed estimate
// address matches an active member's PRIMARY address (customers row) or a
// NON-PRIMARY property (customer_properties, codex #3338 r12) while no
// customerId was linked. Read-only, fail-soft, response-only.

jest.mock('../models/db', () => jest.fn());

const { detectUnlinkedMemberAddress } = require('../services/admin-estimate-persistence');

function fakeDb({ customers = [], properties = [], propertiesThrow = false } = {}) {
  return (table) => {
    const rows = String(table).startsWith('customer_properties')
      ? properties
      : customers;
    const builder = {
      join: () => builder,
      where: () => builder,
      whereNull: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      select: async () => {
        if (String(table).startsWith('customer_properties') && propertiesThrow) {
          throw new Error('relation "customer_properties" does not exist');
        }
        return rows;
      },
    };
    return builder;
  };
}

const MEMBER = {
  id: 'cust-1001',
  first_name: 'Pat',
  last_name: 'Harbor',
  address_line1: '4821 Samplewave Ct',
  city: 'Palmetto',
  zip: '34221',
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
};

describe('detectUnlinkedMemberAddress', () => {
  test('warns when the address matches an active member and no customerId was sent', async () => {
    const database = fakeDb({ customers: [MEMBER] });
    const warning = await detectUnlinkedMemberAddress(database, {
      address: '4821 Samplewave Ct, Palmetto, FL 34221',
    });
    expect(warning).toMatchObject({
      customerId: 'cust-1001',
      customerName: 'Pat Harbor',
      waveguardTier: 'Bronze',
    });
    expect(warning.message).toContain('NOT applied');
  });

  test('a linked save never warns', async () => {
    const database = fakeDb({ customers: [MEMBER] });
    expect(await detectUnlinkedMemberAddress(database, {
      customerId: 'cust-1001',
      address: '4821 Samplewave Ct, Palmetto, FL 34221',
    })).toBeNull();
  });

  test('matches a member through a NON-PRIMARY customer_properties address', async () => {
    const database = fakeDb({
      customers: [],
      properties: [{
        id: 'cust-1001',
        first_name: 'Pat',
        last_name: 'Harbor',
        waveguard_tier: 'Bronze',
        monthly_rate: 55,
        address_line1: '900 Rental Ave',
        city: 'Palmetto',
        zip: '34221',
      }],
    });
    const warning = await detectUnlinkedMemberAddress(database, {
      address: '900 Rental Ave, Palmetto, FL 34221',
    });
    expect(warning).toMatchObject({ customerId: 'cust-1001' });
  });

  test('environments without customer_properties fall back to the primary-address leg only', async () => {
    const database = fakeDb({ customers: [MEMBER], propertiesThrow: true });
    const warning = await detectUnlinkedMemberAddress(database, {
      address: '4821 Samplewave Ct, Palmetto, FL 34221',
    });
    expect(warning).toMatchObject({ customerId: 'cust-1001' });
  });

  test('a non-member match (no tier, no rate) never warns', async () => {
    const database = fakeDb({
      customers: [{ ...MEMBER, waveguard_tier: null, monthly_rate: null }],
    });
    expect(await detectUnlinkedMemberAddress(database, {
      address: '4821 Samplewave Ct, Palmetto, FL 34221',
    })).toBeNull();
  });

  test('a different street never warns', async () => {
    const database = fakeDb({ customers: [MEMBER] });
    expect(await detectUnlinkedMemberAddress(database, {
      address: '4821 Oak Hollow Dr, Palmetto, FL 34221',
    })).toBeNull();
  });
});
