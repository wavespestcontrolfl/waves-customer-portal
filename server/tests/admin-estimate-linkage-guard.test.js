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

const JAY = {
  id: 'cust-jay',
  first_name: 'Jay',
  last_name: 'Fogg',
  address_line1: '1472 Hickory View Cir',
  city: 'Parrish',
  zip: '34219',
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
};

describe('detectUnlinkedMemberAddress', () => {
  test('warns when the address matches an active member and no customerId was sent', async () => {
    const database = fakeDb({ customers: [JAY] });
    const warning = await detectUnlinkedMemberAddress(database, {
      address: '1472 Hickory View Cir, Parrish, FL 34219',
    });
    expect(warning).toMatchObject({
      customerId: 'cust-jay',
      customerName: 'Jay Fogg',
      waveguardTier: 'Bronze',
    });
    expect(warning.message).toContain('NOT applied');
  });

  test('a linked save never warns', async () => {
    const database = fakeDb({ customers: [JAY] });
    expect(await detectUnlinkedMemberAddress(database, {
      customerId: 'cust-jay',
      address: '1472 Hickory View Cir, Parrish, FL 34219',
    })).toBeNull();
  });

  test('matches a member through a NON-PRIMARY customer_properties address', async () => {
    const database = fakeDb({
      customers: [],
      properties: [{
        id: 'cust-jay',
        first_name: 'Jay',
        last_name: 'Fogg',
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
    expect(warning).toMatchObject({ customerId: 'cust-jay' });
  });

  test('environments without customer_properties fall back to the primary-address leg only', async () => {
    const database = fakeDb({ customers: [JAY], propertiesThrow: true });
    const warning = await detectUnlinkedMemberAddress(database, {
      address: '1472 Hickory View Cir, Parrish, FL 34219',
    });
    expect(warning).toMatchObject({ customerId: 'cust-jay' });
  });

  test('a non-member match (no tier, no rate) never warns', async () => {
    const database = fakeDb({
      customers: [{ ...JAY, waveguard_tier: null, monthly_rate: null }],
    });
    expect(await detectUnlinkedMemberAddress(database, {
      address: '1472 Hickory View Cir, Parrish, FL 34219',
    })).toBeNull();
  });

  test('a different street never warns', async () => {
    const database = fakeDb({ customers: [JAY] });
    expect(await detectUnlinkedMemberAddress(database, {
      address: '1472 Oak Hollow Dr, Parrish, FL 34219',
    })).toBeNull();
  });
});
