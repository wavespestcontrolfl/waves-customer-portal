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
  applyPropertyPredicate,
  assignVisitsToEntries,
  appPropertyScopeEnabled,
  resolvedScopePayload,
  isSecondarySelection,
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

// customer_properties "ever had a row?" probe: answers per customer_id from
// global.__EVER__ ({ [customerId]: true }) — the retired-only vs never-had case.
function everRowChain() {
  const c = {}; let filter = {};
  c.where = jest.fn((arg) => { if (typeof arg === 'object') filter = { ...filter, ...arg }; return c; });
  c.first = jest.fn(async () => ((global.__EVER__ || {})[filter.customer_id] ? { id: 'old-row' } : undefined));
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
    global.__EVER__ = {};
    db.mockImplementation((table) => {
      if (table === 'customers') return chain(PROFILES);
      if (table === 'customer_properties') return everRowChain();
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

  test('a cancelled (read-only) session lists only its own profile — no sibling switches, and NO lazy property creation', async () => {
    const cancelled = { ...PROFILES[0], active: false };
    const { properties, selected } = await accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: 'prop-b', customer: cancelled });
    // The profiles query is never issued.
    expect(db).not.toHaveBeenCalledWith('customers');
    // Read-only session: the lazy primary writer is never invoked (codex #4199 r1 P2).
    expect(customerProperties.ensurePrimaryProperty).not.toHaveBeenCalled();
    // ONE entry — the current selection — so no picker offers a switch the cancelled route set refuses (uncapped audit P1).
    expect(properties.map((e) => e.key)).toEqual(['cust-1:prop-b']);
    expect(properties.every((e) => e.customerId === 'cust-1')).toBe(true);
    expect(selected).toEqual({ key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b' });
  });

  test('a cancelled session with no valid claim keeps exactly its primary entry', async () => {
    const cancelled = { ...PROFILES[0], active: false };
    const { properties, selected } = await accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: null, customer: cancelled });
    expect(properties.map((e) => e.key)).toEqual(['cust-1:prop-a']);
    expect(selected.key).toBe('cust-1:prop-a');
  });

  test('a cancelled profile with NO property row still falls back to its own profile entry, without writing one', async () => {
    const cancelled = { ...PROFILES[1], active: false };
    const { properties, selected } = await accountSavedProperties({ customerId: 'cust-9', accountId: 'acct-1', propertyId: null, customer: cancelled });
    expect(customerProperties.ensurePrimaryProperty).not.toHaveBeenCalled();
    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({ key: 'cust-9:profile', customerId: 'cust-9', propertyId: null, address: { line1: '9 Sandbar Ln' } });
    expect(selected).toEqual({ key: 'cust-9:profile', customerId: 'cust-9', propertyId: null });
  });

  test('a failed property READ propagates instead of answering 200 with a profile silently missing (pre-push codex P1)', async () => {
    customerProperties.listProperties.mockRejectedValueOnce(new Error('connection reset'));
    await expect(accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: null })).rejects.toThrow('connection reset');
  });

  test('an active profile whose property rows were all RETIRED is left out (codex #4199 r1 P2) — never a selectable mirrored address', async () => {
    global.__EVER__ = { 'cust-9': true }; // rows exist, none active
    const { properties } = await accountSavedProperties({ customerId: 'cust-1', accountId: 'acct-1', propertyId: null });
    expect(properties.map((e) => e.key)).toEqual(['cust-1:prop-a', 'cust-1:prop-b', 'cust-1:prop-c']);
    expect(properties.some((e) => e.customerId === 'cust-9')).toBe(false);
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
    expect(scope).toEqual({ customerId: 'cust-1', enabled: false, multi: false, scoped: false, closed: false, property: null });
    const { qb, calls } = recordingQb();
    scopeVisitsToProperty(qb, scope);
    expect(calls).toEqual([['where', 'scheduled_services.customer_id', 'cust-1']]);
  });

  test('a cancelled read-only session (req.customerInactive) is never property-scoped, even with a claim', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockClear();
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: 'prop-b', customerInactive: true });
    expect(scope).toEqual({ customerId: 'cust-1', enabled: false, multi: false, scoped: false, closed: false, property: null });
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on, single property → multi=false → no property predicate (single-home customers untouched)', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') { const c = chain([PROPS['cust-1'][0]]); c.first = jest.fn(async () => undefined); return c; } // no retired row
      throw new Error(`unexpected table ${table}`);
    });
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(scope).toMatchObject({ enabled: true, multi: false, scoped: false, closed: false, property: { id: 'prop-a' } });
    const { qb, calls } = recordingQb();
    scopeVisitsToProperty(qb, scope);
    expect(calls).toEqual([['where', 'scheduled_services.customer_id', 'cust-1']]);
  });

  test('gate on, one active PRIMARY plus a RETIRED row keeps the predicate — the retired house\'s stamped visits stay out (GitHub codex r4 P1)', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') { const c = chain([PROPS['cust-1'][0]]); c.first = jest.fn(async () => ({ id: 'retired-row' })); return c; }
      throw new Error(`unexpected table ${table}`);
    });
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(scope).toMatchObject({ enabled: true, multi: false, scoped: true, closed: false, property: { id: 'prop-a', is_primary: true } });
    const rec = recordingQb();
    scopeVisitsToProperty(rec.qb, scope);
    expect(rec.calls).toEqual([
      ['where', 'scheduled_services.customer_id', 'cust-1'],
      ['where(fn)', [['where', 'scheduled_services.property_id', 'prop-a'], ['orWhereNull', 'scheduled_services.property_id']]],
    ]);
  });

  test('gate on, a LONE non-primary property (primary retired) is still scoped — no NULL leg, so the retired primary\'s unstamped visits stay out', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') return chain([PROPS['cust-1'][1]]);
      throw new Error(`unexpected table ${table}`);
    });
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(scope).toMatchObject({ enabled: true, multi: false, scoped: true, closed: false, property: { id: 'prop-b', is_primary: false } });
    const rec = recordingQb();
    scopeVisitsToProperty(rec.qb, scope);
    expect(rec.calls).toEqual([
      ['where', 'scheduled_services.customer_id', 'cust-1'],
      ['where(fn)', [['where', 'scheduled_services.property_id', 'prop-b']]],
    ]);
  });

  test('gate on, every property RETIRED (rows exist, none active) is CLOSED — the reads match nothing; a profile that never had a row keeps today\'s reads', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    let ever = true;
    db.mockImplementation((table) => {
      if (table !== 'customer_properties') throw new Error(`unexpected table ${table}`);
      const c = chain([]);
      c.first = jest.fn(async () => (ever ? { id: 'old-row' } : undefined));
      return c;
    });
    const closed = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(closed).toEqual({ customerId: 'cust-1', enabled: true, multi: false, scoped: true, closed: true, property: null });
    const rec = recordingQb();
    rec.qb.whereNull = jest.fn((col) => { rec.calls.push(['whereNull', col]); return rec.qb; });
    scopeVisitsToProperty(rec.qb, closed);
    expect(rec.calls).toEqual([['where', 'scheduled_services.customer_id', 'cust-1'], ['whereNull', 'scheduled_services.id']]);
    ever = false;
    const never = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(never).toEqual({ customerId: 'cust-1', enabled: true, multi: false, scoped: false, closed: false, property: null });
  });

  test('the resolver is a plain READ once a property row exists — the lazy primary writer (customers FOR UPDATE) runs only for a profile that never had a row', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    customerProperties.ensurePrimaryProperty.mockClear();
    db.mockImplementation((table) => {
      if (table === 'customer_properties') return chain(PROPS['cust-1']);
      throw new Error(`unexpected table ${table}`);
    });
    await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    await resolveSessionScope({ customerId: 'cust-1', propertyId: 'prop-b' });
    // The tracker polls this every 15s: no transaction, no customer-row lock.
    expect(customerProperties.ensurePrimaryProperty).not.toHaveBeenCalled();

    // Every row retired (closed): still a read.
    let ever = true;
    db.mockImplementation((table) => {
      if (table !== 'customer_properties') throw new Error(`unexpected table ${table}`);
      const c = chain([]);
      c.first = jest.fn(async () => (ever ? { id: 'old-row' } : undefined));
      return c;
    });
    await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(customerProperties.ensurePrimaryProperty).not.toHaveBeenCalled();

    // Never had a row: the one-time lazy primary, then a re-read.
    ever = false;
    let reads = 0;
    db.mockImplementation((table) => {
      if (table !== 'customer_properties') throw new Error(`unexpected table ${table}`);
      reads += 1;
      const c = chain(reads >= 3 ? [PROPS['cust-1'][0]] : []);
      c.first = jest.fn(async () => undefined);
      return c;
    });
    const scope = await resolveSessionScope({ customerId: 'cust-1', propertyId: null });
    expect(customerProperties.ensurePrimaryProperty).toHaveBeenCalledTimes(1);
    expect(customerProperties.ensurePrimaryProperty).toHaveBeenCalledWith('cust-1');
    expect(scope).toMatchObject({ enabled: true, multi: false, scoped: false, closed: false, property: { id: 'prop-a' } });
  });

  test('gate on, three properties: the claim wins; the primary also owns unstamped visits; a secondary does not', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockImplementation((table) => {
      if (table === 'customer_properties') return chain(PROPS['cust-1']);
      throw new Error(`unexpected table ${table}`);
    });
    const secondary = await resolveSessionScope({ customerId: 'cust-1', propertyId: 'prop-b' });
    expect(secondary).toMatchObject({ enabled: true, multi: true, scoped: true, property: { id: 'prop-b', is_primary: false } });
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

describe('assignVisitsToEntries — next visit per unified entry', () => {
  const ENTRIES = [
    { key: 'c1:pa', customerId: 'c1', propertyId: 'pa', isPrimaryProperty: true },
    { key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false },
    { key: 'c9:pz', customerId: 'c9', propertyId: 'pz', isPrimaryProperty: true },
  ];
  test('unstamped → primary; stamped → its entry; retired stamp → nobody; lone-entry profile owns everything; first visit wins', () => {
    const next = assignVisitsToEntries(ENTRIES, [
      { id: 'v1', customer_id: 'c1', property_id: null },
      { id: 'v2', customer_id: 'c1', property_id: 'pb' },
      { id: 'v3', customer_id: 'c1', property_id: 'pa' }, // later than v1 → primary keeps v1
      { id: 'v4', customer_id: 'c1', property_id: 'retired' },
      { id: 'v5', customer_id: 'c9', property_id: 'something-else' }, // stamped to a retired house → nobody, even for a lone primary (GitHub codex r4 P1)
      { id: 'v7', customer_id: 'c9', property_id: null }, // unstamped → the lone primary
      { id: 'v6', customer_id: 'c-unknown', property_id: null },
    ]);
    expect([...next.entries()].map(([k, v]) => [k, v.id])).toEqual([['c1:pa', 'v1'], ['c1:pb', 'v2'], ['c9:pz', 'v7']]);
  });
  test('a lone NON-primary entry owns only its stamped visits (its primary was retired)', () => {
    const next = assignVisitsToEntries([{ key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false }], [
      { id: 'v1', customer_id: 'c1', property_id: null },
      { id: 'v2', customer_id: 'c1', property_id: 'pb' },
    ]);
    expect([...next.entries()].map(([k, v]) => [k, v.id])).toEqual([['c1:pb', 'v2']]);
  });
  test('a multi-property profile with NO active primary leaves unstamped visits unassigned — the list route would not show them under a secondary either', () => {
    const noPrimary = [
      { key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false },
      { key: 'c1:pc', customerId: 'c1', propertyId: 'pc', isPrimaryProperty: false },
    ];
    const next = assignVisitsToEntries(noPrimary, [
      { id: 'v1', customer_id: 'c1', property_id: null },
      { id: 'v2', customer_id: 'c1', property_id: 'pc' },
    ]);
    expect([...next.entries()].map(([k, v]) => [k, v.id])).toEqual([['c1:pc', 'v2']]);
  });
});

describe('applyPropertyPredicate — the property half alone', () => {
  function rec() {
    const calls = [];
    const qb = {
      where: jest.fn((a, b) => {
        if (typeof a === 'function') { const inner = rec(); a.call(inner.qb, inner.qb); calls.push(['where(fn)', inner.calls]); }
        else calls.push(['where', a, b]);
        return qb;
      }),
      orWhereNull: jest.fn((col) => { calls.push(['orWhereNull', col]); return qb; }),
    };
    return { qb, calls };
  }
  test('adds nothing when disabled, single, or property-less; adds the rule (with the NULL leg for the primary) otherwise, on the given alias', () => {
    for (const scope of [
      { customerId: 'c1', enabled: false, scoped: true, property: { id: 'pa', is_primary: true } },
      { customerId: 'c1', enabled: true, scoped: false, property: { id: 'pa', is_primary: true } },
      null,
    ]) {
      const r = rec(); applyPropertyPredicate(r.qb, scope); expect(r.calls).toEqual([]);
    }
    const primary = rec();
    applyPropertyPredicate(primary.qb, { customerId: 'c1', enabled: true, scoped: true, property: { id: 'pa', is_primary: true } }, 'ss');
    expect(primary.calls).toEqual([['where(fn)', [['where', 'ss.property_id', 'pa'], ['orWhereNull', 'ss.property_id']]]]);
    const secondary = rec();
    applyPropertyPredicate(secondary.qb, { customerId: 'c1', enabled: true, scoped: true, property: { id: 'pb', is_primary: false } });
    expect(secondary.calls).toEqual([['where(fn)', [['where', 'scheduled_services.property_id', 'pb']]]]);
  });
});

describe('isSecondarySelection — when customer-wide self-serve surfaces must step aside', () => {
  test('true only for an enabled, multi-property scope resolved to a NON-primary property', () => {
    expect(isSecondarySelection({ customerId: 'c1', enabled: true, scoped: true, property: { id: 'pb', is_primary: false } })).toBe(true);
    expect(isSecondarySelection({ customerId: 'c1', enabled: true, scoped: true, property: { id: 'pa', is_primary: true } })).toBe(false);
    // A lone secondary (primary retired) IS a secondary selection; every property retired (closed) is too.
    expect(isSecondarySelection({ customerId: 'c1', enabled: true, multi: false, scoped: true, property: { id: 'pb', is_primary: false } })).toBe(true);
    expect(isSecondarySelection({ customerId: 'c1', enabled: true, scoped: true, closed: true, property: null })).toBe(true);
    expect(isSecondarySelection({ customerId: 'c1', enabled: true, scoped: false, property: { id: 'pa', is_primary: true } })).toBe(false);
    expect(isSecondarySelection({ customerId: 'c1', enabled: false, scoped: false, property: null })).toBe(false);
    expect(isSecondarySelection(null)).toBe(false);
  });
});

describe('resolvedScopePayload — what a scoped read was actually resolved to (uncapped codex r1m)', () => {
  test('names the fallback the server chose; null when no predicate applied; closed when every row is retired', () => {
    const primary = { id: 'prop-a', is_primary: true };
    const secondary = { id: 'prop-b', is_primary: false };
    expect(resolvedScopePayload({ enabled: true, multi: true, scoped: true, closed: false, property: primary })).toEqual({ enabled: true, propertyId: 'prop-a', closed: false });
    // A lone secondary after the primary was retired — the client must NOT read this as "the primary".
    expect(resolvedScopePayload({ enabled: true, multi: false, scoped: true, closed: false, property: secondary })).toEqual({ enabled: true, propertyId: 'prop-b', closed: false });
    // Single home: no predicate → null.
    expect(resolvedScopePayload({ enabled: true, multi: false, scoped: false, closed: false, property: primary })).toEqual({ enabled: true, propertyId: null, closed: false });
    expect(resolvedScopePayload({ enabled: true, multi: false, scoped: true, closed: true, property: null })).toEqual({ enabled: true, propertyId: null, closed: true });
    expect(resolvedScopePayload({ enabled: false, multi: false, scoped: false, closed: false, property: null })).toEqual({ enabled: false, propertyId: null, closed: false });
    expect(resolvedScopePayload(null)).toEqual({ enabled: false, propertyId: null, closed: false });
  });
});
