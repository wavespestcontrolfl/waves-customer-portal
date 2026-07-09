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

  test('slot-only single match: household role links; agent role never links; no signal falls through', async () => {
    const base = {
      id: 'landlord', first_name: 'Pat', phone: '+19415559999',
      service_contact_phone: PHONE, service_contact_name: 'Maria Lopez',
    };
    // (When a first_name is extracted, the named query consumes one queued
    // result before the phone-only fetch — feed it an empty miss.)
    // Household role → linked.
    mockDbQueue({ customers: [[{ ...base, service_contact_role: 'tenant' }]] });
    expect((await findCustomerForCallContact(PHONE, {}))?.id).toBe('landlord');
    // Agent-type role → never auto-links, even with a name match.
    mockDbQueue({ customers: [[], [{ ...base, service_contact_role: 'real_estate_agent' }]] });
    expect(await findCustomerForCallContact(PHONE, { first_name: 'Maria' })).toBeNull();
    // No role, name agrees with the SLOT's own name → linked.
    mockDbQueue({ customers: [[], [{ ...base, service_contact_role: null }]] });
    expect((await findCustomerForCallContact(PHONE, { first_name: 'Maria' }))?.id).toBe('landlord');
    // No role, no name signal → falls through (legacy create/lead path).
    mockDbQueue({ customers: [[{ ...base, service_contact_role: null }]] });
    expect(await findCustomerForCallContact(PHONE, {})).toBeNull();
  });

  test('name fast path: slot-phone hit still passes role gating (round-2 P1)', async () => {
    // A realtor's phone stored in a slot on a customer who happens to share
    // the caller's first name: the named query returns that customer, but
    // the fast path must NOT link — agent-type slots never auto-link.
    const sameNamedCustomer = {
      id: 'prev-buyer', first_name: 'Karen', last_name: null, phone: '+19415559999',
      service_contact_phone: PHONE, service_contact_name: 'Karen Realtor',
      service_contact_role: 'real_estate_agent',
    };
    mockDbQueue({ customers: [[sameNamedCustomer]] });
    expect(await findCustomerForCallContact(PHONE, { first_name: 'Karen' })).toBeNull();
  });

  test('name fast path: primary-phone owner and household slot still link', async () => {
    // Positive controls — the gating must not break the legitimate paths.
    const owner = { id: 'own', first_name: 'Karen', phone: PHONE };
    mockDbQueue({ customers: [[owner]] });
    expect((await findCustomerForCallContact(PHONE, { first_name: 'Karen' }))?.id).toBe('own');

    const householdSlot = {
      id: 'landlord', first_name: 'Karen', phone: '+19415559999',
      service_contact_phone: PHONE, service_contact_name: 'Terry Tenant',
      service_contact_role: 'tenant',
    };
    mockDbQueue({ customers: [[householdSlot]] });
    expect((await findCustomerForCallContact(PHONE, { first_name: 'Karen' }))?.id).toBe('landlord');
  });

  test('conflicting V2 mirror contact is dropped from the plural list', () => {
    const v1Matt = { first_name: 'Matt', last_name: null, phone: '+19415551111', email: null, role: 'real_estate_agent', wants_notifications: false, notes: null };
    const v2Sarah = { name_full: 'Sarah Miller', first_name: 'Sarah', last_name: 'Miller', phone_e164: '+19415550101', phone_raw_spoken: null, email: null, role: 'home_buyer', wants_notifications: true, notes: null };
    const v2Rita = { name_full: 'Rita Doyle', first_name: 'Rita', last_name: 'Doyle', phone_e164: '+19415550303', phone_raw_spoken: null, email: null, role: 'home_seller', wants_notifications: false, notes: null };
    const out = resolveCallSecondaryContacts(
      { secondary_contact: v1Matt },
      { secondary_contact: v2Sarah, secondary_contacts: [v2Sarah, v2Rita] },
    );
    // V1 Matt won the identity conflict; V2's rejected Sarah must NOT come
    // back as an "additional" contact — only the genuinely-different Rita.
    expect(out.map((c) => c.first_name)).toEqual(['Matt', 'Rita']);
  });

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
    expect(out).toEqual({ propertyId: null, address: null, lat: null, lng: null });
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

// ─── Stamped-address divergence rule (codex round-4 P1) ─────────────────────
describe('stampedAddressDiverges', () => {
  const { stampedAddressDiverges } = require('../services/stamped-address');

  test('unstamped visit never diverges', () => {
    expect(stampedAddressDiverges({ customer_address_line1: '123 Main St' })).toBe(false);
    expect(stampedAddressDiverges({})).toBe(false);
  });

  test('stamp matching the primary (case/space-insensitive) does not diverge', () => {
    expect(stampedAddressDiverges({
      service_address_line1: '123  MAIN st ',
      customer_address_line1: '123 Main St',
    })).toBe(false);
  });

  test('different street line diverges', () => {
    expect(stampedAddressDiverges({
      service_address_line1: '456 Rental Ave',
      customer_address_line1: '123 Main St',
    })).toBe(true);
  });

  test('same street line in a different ZIP diverges; missing ZIPs do not', () => {
    expect(stampedAddressDiverges({
      service_address_line1: '123 Main St', service_address_zip: '34285',
      customer_address_line1: '123 Main St', customer_zip: '34202',
    })).toBe(true);
    expect(stampedAddressDiverges({
      service_address_line1: '123 Main St', service_address_zip: '34285',
      customer_address_line1: '123 Main St', customer_zip: null,
    })).toBe(false);
  });

  test('stamped visit for a customer with no primary on file diverges (no valid fallback)', () => {
    expect(stampedAddressDiverges({ service_address_line1: '456 Rental Ave' })).toBe(true);
  });
});
