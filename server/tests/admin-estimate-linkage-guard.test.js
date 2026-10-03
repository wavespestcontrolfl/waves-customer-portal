process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// detectUnlinkedMemberAddress — the save-time unlinked-member guard
// (workstream-1 hardening, 2026-08-10). Warns when the typed estimate
// address matches an active member's PRIMARY address (customers row) or a
// NON-PRIMARY property (customer_properties, codex #3338 r12) while no
// customerId was linked. Read-only, fail-soft, response-only.

jest.mock('../models/db', () => jest.fn());

const { detectUnlinkedMemberAddress, resolveContactLinkedCustomer } = require('../services/admin-estimate-persistence');
const existingServices = require('../services/waveguard-existing-services');
const { phoneIdentityKey } = require('../utils/phone');

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

// resolveContactLinkedCustomer — the save-time contact link (owner
// 2026-10-03): a new estimate with no customer picked links to the ONE live
// customer its typed phone belongs to, unless that
// link would change the price. A wrong link moves a quote onto another
// account, so every refusal below is pinned. Identities are synthetic.
describe('resolveContactLinkedCustomer', () => {
  const LEAD = { id: 'cust-2001', first_name: 'Robin', last_name: 'Example', phone: '+19415550142', email: 'robin@example.com', waveguard_tier: null, monthly_rate: null };
  const HOUSEMATE = { ...LEAD, id: 'cust-2002', first_name: 'Sam', email: 'sam@example.com' };

  // customers rows filtered by the phone / email predicate the resolver sends.
  function contactDb(customers) {
    return () => {
      let rows = customers.filter((c) => !c.deleted_at);
      const builder = {
        whereNull: () => builder,
        where: () => builder,
        whereRaw: (sql, [value]) => {
          expect(sql).toContain('phone');
          rows = rows.filter((c) => phoneIdentityKey(c.phone) === value);
          return builder;
        },
        limit: (n) => { rows = rows.slice(0, n); return builder; },
        select: async () => rows,
        first: async () => rows[0] || null,
      };
      return builder;
    };
  }
  let loadKeys;
  beforeEach(() => {
    loadKeys = jest.spyOn(existingServices, 'loadExistingQualifyingServiceKeys').mockResolvedValue([]);
  });
  afterEach(() => loadKeys.mockRestore());

  test('the typed phone of exactly one customer links it, in any phone format; no price change', async () => {
    const link = await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '(941) 555-0142', address: '12 Sample St, Bradenton, FL 34202' });
    expect(link).toMatchObject({ customer: { id: 'cust-2001' }, changesPrice: false });
  });

  // The wrong-customer class of codex #4213: a shared last-ten-digits suffix.
  test('a number from another country never links a US customer that shares its last ten digits', async () => {
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '+449415550142' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([{ ...LEAD, phone: '+449415550142' }]), { customerPhone: '(941) 555-0142' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '555-0142' })).toBeNull();
  });

  test('two customers on the phone link nobody, and an email match never links', async () => {
    expect(await resolveContactLinkedCustomer(contactDb([LEAD, HOUSEMATE]), { customerPhone: '+19415550142', customerEmail: 'robin@example.com' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '941-555-0199', customerEmail: 'robin@example.com' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerEmail: 'robin@example.com' })).toBeNull();
  });

  test('links nothing with a customer already picked, no contact, a placeholder phone, an unknown contact or a deleted customer', async () => {
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerId: 'cust-9', customerPhone: '+19415550142' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), {})).toBeNull();
    // A carrier placeholder is nobody's number, whatever email rides with it (Codex r1 on #5863).
    expect(await resolveContactLinkedCustomer(contactDb([{ ...LEAD, phone: '+17378742833' }]), { customerPhone: '+17378742833', customerEmail: 'robin@example.com' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '+19415550100' })).toBeNull();
    expect(await resolveContactLinkedCustomer(contactDb([{ ...LEAD, deleted_at: new Date() }]), { customerPhone: '+19415550142' })).toBeNull();
  });

  test('a member, or a customer with existing qualifying services, is handed back to warn about, never linked silently', async () => {
    const member = await resolveContactLinkedCustomer(contactDb([{ ...LEAD, waveguard_tier: 'Silver', monthly_rate: 80 }]), { customerPhone: '+19415550142' });
    expect(member).toMatchObject({ customer: { id: 'cust-2001' }, changesPrice: true });
    loadKeys.mockResolvedValue(['pest_control']);
    const recurring = await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '+19415550142' });
    expect(recurring.changesPrice).toBe(true);
  });

  test('a failed lookup leaves the estimate unlinked instead of failing the save', async () => {
    loadKeys.mockRejectedValue(new Error('db down'));
    expect(await resolveContactLinkedCustomer(contactDb([LEAD]), { customerPhone: '+19415550142' })).toBeNull();
    expect(await resolveContactLinkedCustomer(() => { throw new Error('db down'); }, { customerPhone: '+19415550142' })).toBeNull();
  });
});
