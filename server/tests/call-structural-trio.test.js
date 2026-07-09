/**
 * Structural trio (2026-07-09, owner-signed): appointment property linkage,
 * secondary_contacts array + slot roles, and the customer-matching cascade.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const { _test } = require('../services/call-recording-processor');
const {
  resolveCallSecondaryContacts,
  resolveCallBookingPropertyLinkage,
  findCustomerForCallContact,
  sameFirstName,
  extractedNameMatchesCustomer,
} = _test;
const { normalizeSecondaryContacts } = require('../utils/normalize-extraction-v2');
const { mapSecondaryContactsToLegacy } = require('../utils/extraction-compat');
const { getServiceContactSlots, SERVICE_CONTACT_SLOTS } = require('../services/customer-contact');

afterEach(() => db.mockReset());

// ─── B: secondary_contacts array ────────────────────────────────────────────

describe('resolveCallSecondaryContacts', () => {
  const v2Entry = (first, last, phone, role = 'home_buyer', wants = true) => ({
    name_full: `${first} ${last}`, first_name: first, last_name: last,
    phone_e164: phone, phone_raw_spoken: null, email: null,
    role, wants_notifications: wants, notes: null,
  });

  test('V1 single + V2 array merge, dedupe by phone, ordered, capped at 3', () => {
    const v1 = { first_name: 'Sarah', last_name: 'Miller', phone: '+19415550101', email: null, role: 'home_buyer', wants_notifications: true, notes: null };
    const v2 = {
      secondary_contact: v2Entry('Sarah', 'Miller', '+19415550101'),
      secondary_contacts: [
        v2Entry('Sarah', 'Miller', '+19415550101'),
        v2Entry('Mark', 'Doyle', '+19415550202', 'real_estate_agent'),
        v2Entry('Rita', 'Doyle', '+19415550303', 'home_seller', false),
        v2Entry('Extra', 'Person', '+19415550404', 'other'),
      ],
    };
    const out = resolveCallSecondaryContacts({ secondary_contact: v1 }, v2);
    expect(out).toHaveLength(3);
    expect(out[0].first_name).toBe('Sarah');
    expect(out[1].first_name).toBe('Mark');
    expect(out[2].first_name).toBe('Rita');
    expect(out[2].wants_notifications).toBe(false);
  });

  test('no parties → empty list; single party → one entry', () => {
    expect(resolveCallSecondaryContacts({}, null)).toEqual([]);
    const v2 = { secondary_contact: v2Entry('Joe', 'H', '+19415551111') };
    expect(resolveCallSecondaryContacts({}, v2)).toHaveLength(1);
  });

  test('normalizeSecondaryContacts drops empty shells, caps at 3, nulls garbage', () => {
    const shell = { role: 'tenant', wants_notifications: true, notes: 'x' };
    const real = (n) => ({ first_name: n, last_name: null, name_full: null, phone_e164: `+1941555000${n.length}`, phone_raw_spoken: null, email: null, role: 'tenant', wants_notifications: true, notes: null });
    const out = normalizeSecondaryContacts([shell, real('A'), real('Bb'), real('Ccc'), real('Dddd')]);
    expect(out).toHaveLength(3);
    expect(normalizeSecondaryContacts('garbage')).toBeNull();
  });

  test('mapSecondaryContactsToLegacy maps and drops empties', () => {
    const out = mapSecondaryContactsToLegacy([
      v2Entry('Sarah', 'Miller', '+19415550101'),
      { role: 'other', wants_notifications: false },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].phone).toBe('+19415550101');
  });
});

// ─── B: slot roles ──────────────────────────────────────────────────────────

describe('service-contact slot roles', () => {
  test('SERVICE_CONTACT_SLOTS carry roleCol and getServiceContactSlots exposes contactRole', () => {
    for (const slot of SERVICE_CONTACT_SLOTS) expect(slot.roleCol).toMatch(/_role$/);
    const slots = getServiceContactSlots({
      service_contact_name: 'Sarah Miller',
      service_contact_phone: '+19415550101',
      service_contact_email: null,
      service_contact_role: 'home_buyer',
    });
    expect(slots[0].contactRole).toBe('home_buyer');
    expect(slots[1].contactRole).toBeNull();
  });
});

// ─── C: nickname-tolerant matching ──────────────────────────────────────────

describe('nickname-tolerant name matching', () => {
  test('sameFirstName groups diminutives; strangers stay distinct', () => {
    expect(sameFirstName('bob', 'robert')).toBe(true);
    expect(sameFirstName('kathy', 'katherine')).toBe(true);
    expect(sameFirstName('bob', 'william')).toBe(false);
  });

  test('extractedNameMatchesCustomer accepts a nickname but still enforces surname', () => {
    expect(extractedNameMatchesCustomer(
      { first_name: 'Bob', last_name: 'Smith' },
      { first_name: 'Robert', last_name: 'Smith' },
    )).toBe(true);
    expect(extractedNameMatchesCustomer(
      { first_name: 'Bob', last_name: 'Jones' },
      { first_name: 'Robert', last_name: 'Smith' },
    )).toBe(false);
  });
});

// ─── C: matching cascade ────────────────────────────────────────────────────

describe('findCustomerForCallContact cascade', () => {
  const PHONE = '+15555550123';

  function mockDbQueue(resultsByTable) {
    // Each db(table) call shifts the next queued result for that table.
    const queues = { ...resultsByTable };
    db.mockImplementation((table) => {
      const builder = {
        where: () => builder,
        whereIn: () => builder,
        whereNull: () => builder,
        whereNot: () => builder,
        whereRaw: () => builder,
        orWhereRaw: () => builder,
        orderBy: () => builder,
        orderByRaw: () => builder,
        limit: () => builder,
        count: () => builder,
        select: () => builder,
        first: () => Promise.resolve((queues[table] || []).shift() ?? null),
        then: (resolve, reject) => Promise.resolve((queues[table] || []).shift() ?? []).then(resolve, reject),
      };
      return builder;
    });
  }

  test('leg (a): exactly one candidate OWNS the number as primary → linked', async () => {
    const owner = { id: 'own', first_name: 'Jordan', phone: PHONE };
    const slotHolder = { id: 'slot', first_name: 'Realtor', phone: '+19415559999' };
    mockDbQueue({ customers: [[owner, slotHolder]] });
    const result = await findCustomerForCallContact(PHONE, {});
    expect(result).toBe(owner);
  });

  test('household leg: all candidates share one address key → most recent linked', async () => {
    const a = { id: 'a', first_name: 'Mary', phone: PHONE, address_line1: '12 Oak St', city: 'Venice', zip: '34285' };
    const b = { id: 'b', first_name: 'Bob', phone: PHONE, address_line1: '12 Oak Street', city: 'Venice', zip: '34285' };
    mockDbQueue({ customers: [[a, b]] });
    const result = await findCustomerForCallContact(PHONE, {});
    expect(result).toBe(a);
  });

  test('ambiguous: different households → null + multiMatchOut populated', async () => {
    const a = { id: 'a', first_name: 'Mary', phone: PHONE, address_line1: '12 Oak St', city: 'Venice', zip: '34285' };
    const b = { id: 'b', first_name: 'Sue', phone: PHONE, address_line1: '99 Pine Ave', city: 'Nokomis', zip: '34275' };
    mockDbQueue({ customers: [[a, b], [{ n: 2 }]] });
    const out = {};
    const result = await findCustomerForCallContact(PHONE, {}, { multiMatchOut: out });
    expect(result).toBeNull();
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0].id).toBe('a');
  });

  test('AV-address leg: decisive verdict + one property owner → linked', async () => {
    const a = { id: 'a', first_name: 'Mary', phone: PHONE, address_line1: '1 Elm St', city: 'Venice', zip: '34285' };
    const b = { id: 'b', first_name: 'Sue', phone: PHONE, address_line1: '9 Ash Ct', city: 'Nokomis', zip: '34275' };
    mockDbQueue({
      customers: [[a, b]],
      customer_properties: [[{ customer_id: 'b', address_line1: '456 Pine Ave', address_line2: null, city: 'Venice', zip: '34285' }]],
    });
    const result = await findCustomerForCallContact(PHONE, {}, {
      avDecisive: true,
      callAddress: { address_line1: '456 Pine Ave', address_line2: null, city: 'Venice', zip: '34285' },
    });
    expect(result).toBe(b);
  });
});

// ─── A: property linkage ────────────────────────────────────────────────────

describe('resolveCallBookingPropertyLinkage', () => {
  function mockProps(rows) {
    db.mockImplementation((table) => {
      const builder = {
        where: () => builder,
        select: () => Promise.resolve(table === 'customer_properties' ? rows : []),
      };
      return builder;
    });
    return db;
  }

  test('exact address-key match resolves the property id and stamps the address', async () => {
    const trx = mockProps([
      { id: 'prop-home', address_line1: '123 Oak St', address_line2: null, city: 'Venice', zip: '34285' },
      { id: 'prop-rental', address_line1: '456 Pine Ave', address_line2: null, city: 'Venice', zip: '34285' },
    ]);
    const out = await resolveCallBookingPropertyLinkage('cust-1', {
      address_line1: '456 Pine Avenue', city: 'Venice', state: 'FL', zip: '34285',
    }, trx);
    expect(out.propertyId).toBe('prop-rental');
    expect(out.address.line1).toBe('456 Pine Avenue');
    expect(out.address.zip).toBe('34285');
  });

  test('no call address → nulls (readers fall back to the customer mirror)', async () => {
    const out = await resolveCallBookingPropertyLinkage('cust-1', {}, mockProps([]));
    expect(out).toEqual({ propertyId: null, address: null });
  });

  test('ambiguous (two properties share the key) → address stamped, property unlinked', async () => {
    const trx = mockProps([
      { id: 'p1', address_line1: '456 Pine Ave', address_line2: null, city: 'Venice', zip: '34285' },
      { id: 'p2', address_line1: '456 Pine Avenue', address_line2: null, city: 'Venice', zip: '34285' },
    ]);
    const out = await resolveCallBookingPropertyLinkage('cust-1', {
      address_line1: '456 Pine Ave', city: 'Venice', state: 'FL', zip: '34285',
    }, trx);
    expect(out.propertyId).toBeNull();
    expect(out.address.line1).toBe('456 Pine Ave');
  });
});
