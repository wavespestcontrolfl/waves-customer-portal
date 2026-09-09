/**
 * services/account-properties — saved-property scope (GATE_APP_PROPERTY_SCOPE):
 * the unified (profile × saved property) list, the session selection, the
 * per-request scope and the visit rule.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-properties', () => ({
  ensurePrimaryProperty: jest.fn(async () => ({ created: false, propertyId: null })),
  listProperties: jest.fn(async (customerId) => (global.__PROPS__ || {})[customerId] || []),
}));

const db = require('../models/db');
const customerProperties = require('../services/customer-properties');
const {
  accountSavedProperties,
  resolveSessionScope,
  scopeVisitsToProperty,
  appPropertyScopeEnabled,
} = require('../services/account-properties');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'orWhere', 'orderBy', 'select']) {
    c[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(c, c); return c; });
  }
  c.first = jest.fn(async () => rows[0]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

const PROFILES = [
  { id: 'cust-1', account_id: 'acct-1', profile_label: 'Primary', is_primary_profile: true, active: true, waveguard_tier: 'Bronze', address_line1: '1200 Palm Row Ct', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
  { id: 'cust-9', account_id: 'acct-1', profile_label: 'Rental - Sandbar Ln', is_primary_profile: false, active: true, waveguard_tier: null, address_line1: '9 Sandbar Ln', address_line2: null, city: 'Ellenton', state: 'FL', zip: '34222' },
];
const PROPS = {
  'cust-1': [
    { id: 'prop-a', customer_id: 'cust-1', is_primary: true, label: 'Primary', relationship: 'own_home', occupancy_type: 'owner_occupied', address_line1: '1200 Palm Row Ct', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
    { id: 'prop-b', customer_id: 'cust-1', is_primary: false, label: null, relationship: 'family_home', occupancy_type: 'family_occupied', address_line1: '418 Oak Ave', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
    { id: 'prop-c', customer_id: 'cust-1', is_primary: false, label: null, relationship: 'family_home', occupancy_type: 'family_occupied', address_line1: '77 Pine Ct', address_line2: null, city: 'Palmetto', state: 'FL', zip: '34221' },
  ],
  // The rental profile has no saved-property row yet (no lazy primary possible in this fake).
};

describe('accountSavedProperties — the unified list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.__PROPS__ = PROPS;
    db.mockImplementation((table) => {
      if (table === 'customers') return chain(PROFILES);
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('one entry per (profile, saved property), primary profile first, primary property first; a row-less profile lists once', async () => {
    const req = { customerId: 'cust-1', accountId: 'acct-1', propertyId: null };
    const { properties, selected } = await accountSavedProperties(req);

    expect(properties.map((e) => e.key)).toEqual(['cust-1:prop-a', 'cust-1:prop-b', 'cust-1:prop-c', 'cust-9:profile']);
    expect(properties[0]).toEqual({
      key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a',
      isPrimaryProfile: true, profileLabel: 'Primary', isPrimaryProperty: true,
      label: 'Primary', relationship: 'own_home', occupancyType: 'owner_occupied', tier: 'Bronze',
      address: { line1: '1200 Palm Row Ct', line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
    });
    expect(properties[1]).toMatchObject({ propertyId: 'prop-b', isPrimaryProperty: false, relationship: 'family_home', label: null });
    // Profile without a saved row: keyed to the profile, address from the customers mirror, treated as its own primary.
    expect(properties[3]).toMatchObject({ customerId: 'cust-9', propertyId: null, isPrimaryProfile: false, profileLabel: 'Rental - Sandbar Ln', isPrimaryProperty: true, address: { line1: '9 Sandbar Ln', city: 'Ellenton' } });
    // Lazy primary attempted for every profile, exactly as the admin list does.
    expect(customerProperties.ensurePrimaryProperty).toHaveBeenCalledTimes(2);
    // No claim → the signed-in profile's primary is selected.
    expect(selected).toEqual({ key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a' });
  });

  test('a cancelled (read-only) session lists only its own profile — no sibling switches it cannot take', async () => {
    const cancelled = { ...PROFILES[0], active: false };
    const { properties, selected } = await accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: 'prop-b', customer: cancelled });
    // The profiles query is never issued — db would throw on any other table, and 'customers' was not asked for.
    expect(db).not.toHaveBeenCalledWith('customers');
    expect(properties.map((e) => e.key)).toEqual(['cust-1:prop-a', 'cust-1:prop-b', 'cust-1:prop-c']);
    expect(properties.every((e) => e.customerId === 'cust-1')).toBe(true);
    expect(selected).toEqual({ key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b' });
  });

  test('selected follows a validated claim; a claim that is not among the profile\'s entries falls back to the primary', async () => {
    const withClaim = await accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: 'prop-c' });
    expect(withClaim.selected).toEqual({ key: 'cust-1:prop-c', customerId: 'cust-1', propertyId: 'prop-c' });
    const stale = await accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: 'prop-zzz' });
    expect(stale.selected.propertyId).toBe('prop-a');
    // Signed in as the row-less rental profile → its profile entry is the selection.
    const rental = await accountSavedProperties({ customerId: 'cust-9', accountId: 'acct-1', propertyId: null });
    expect(rental.selected).toEqual({ key: 'cust-9:profile', customerId: 'cust-9', propertyId: null });
  });
});

describe('resolveSessionScope + scopeVisitsToProperty — the visit rule', () => {
  const originalGate = process.env.GATE_APP_PROPERTY_SCOPE;
  afterEach(() => {
    if (originalGate === undefined) delete process.env.GATE_APP_PROPERTY_SCOPE;
    else process.env.GATE_APP_PROPERTY_SCOPE = originalGate;
  });

  function recordingQb() {
    const calls = [];
    const qb = {
      where: jest.fn((a, b) => {
        if (typeof a === 'function') { const inner = recordingQb(); a.call(inner.qb, inner.qb); calls.push(['where(fn)', inner.calls]); }
        else calls.push(['where', a, b]);
        return qb;
      }),
      orWhereNull: jest.fn((col) => { calls.push(['orWhereNull', col]); return qb; }),
    };
    return { qb, calls };
  }

  test('gate off → scope disabled and the query keeps only the customer predicate', async () => {
    delete process.env.GATE_APP_PROPERTY_SCOPE;
    expect(appPropertyScopeEnabled()).toBe(false);
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: 'prop-b' });
    expect(scope).toEqual({ customerId: 'cust-1', enabled: false, multi: false, property: null });
    const { qb, calls } = recordingQb();
    scopeVisitsToProperty(qb, scope);
    expect(calls).toEqual([['where', 'scheduled_services.customer_id', 'cust-1']]);
  });

  test('gate on, single property → multi=false → no property predicate (single-home customers untouched)', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') return chain([PROPS['cust-1'][0]]);
      throw new Error(`unexpected table ${table}`);
    });
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(scope).toMatchObject({ enabled: true, multi: false, property: { id: 'prop-a' } });
    const { qb, calls } = recordingQb();
    scopeVisitsToProperty(qb, scope);
    expect(calls).toEqual([['where', 'scheduled_services.customer_id', 'cust-1']]);
  });

  test('gate on, three properties: the claim wins; the primary also owns unstamped visits; a secondary does not', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') return chain(PROPS['cust-1']);
      throw new Error(`unexpected table ${table}`);
    });
    const secondary = await resolveSessionScope({ customerId: 'cust-1', propertyId: 'prop-b' });
    expect(secondary).toMatchObject({ enabled: true, multi: true, property: { id: 'prop-b', is_primary: false } });
    let rec = recordingQb();
    scopeVisitsToProperty(rec.qb, secondary, 'ss');
    expect(rec.calls).toEqual([
      ['where', 'ss.customer_id', 'cust-1'],
      ['where(fn)', [['where', 'ss.property_id', 'prop-b']]],
    ]);

    const primary = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(primary.property.id).toBe('prop-a');
    rec = recordingQb();
    scopeVisitsToProperty(rec.qb, primary);
    expect(rec.calls).toEqual([
      ['where', 'scheduled_services.customer_id', 'cust-1'],
      ['where(fn)', [['where', 'scheduled_services.property_id', 'prop-a'], ['orWhereNull', 'scheduled_services.property_id']]],
    ]);

    // A claim the customer does not own is not among the rows → primary.
    const foreign = await resolveSessionScope({ customerId: 'cust-1', propertyId: 'prop-of-someone-else' });
    expect(foreign.property.id).toBe('prop-a');
  });
});
