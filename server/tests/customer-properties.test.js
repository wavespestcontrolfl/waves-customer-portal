const { normStreet, addressKey, unitKey, streetEmbeddedUnitKey, streetKey, normalizeZip, normalizeOccupancy, isNewAddress, OCCUPANCY_TYPES, defaultOccupancyForContactRole, defaultRelationshipForContactRole } = require('../services/customer-properties');

describe('address key normalization (suffix + ZIP)', () => {
  test('normalizeZip takes the 5-digit form (ZIP+4 insensitive)', () => {
    expect(normalizeZip('34205-1234')).toBe('34205');
    expect(normalizeZip('34205')).toBe('34205');
    expect(normalizeZip('')).toBe('');
  });
  test('addressKey is ZIP+4-insensitive', () => {
    const a = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
    const b = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205-1234' };
    expect(addressKey(a)).toBe(addressKey(b));
  });
  test('streetKey canonicalizes suffixes (St==Street) but keeps St!=Ave', () => {
    expect(streetKey('123 Main St')).toBe(streetKey('123 Main Street'));
    expect(streetKey('123 Main St')).not.toBe(streetKey('123 Main Ave'));
  });
  test('streetKey strips a trailing unit so a street-only compare ignores units', () => {
    expect(streetKey('100 Main St Apt 4')).toBe(streetKey('100 Main St'));
    expect(streetKey('100 Main St #4')).toBe(streetKey('100 Main Street'));
    // but addressKey (full) still keeps the unit distinct
    expect(addressKey({ address_line1: '100 Main St', address_line2: 'Apt 4', city: 'Bradenton' }))
      .not.toBe(addressKey({ address_line1: '100 Main St', city: 'Bradenton' }));
  });
});

describe('customer-properties pure helpers', () => {
  test('normStreet ignores case/space/punctuation but keeps the house number', () => {
    // spacing/punctuation/case variants of the SAME street collapse together
    expect(normStreet('12338 Ambercreek Cir')).toBe('12338ambercreekcir');
    expect(normStreet('12338  amber-creek  CIR.')).toBe('12338ambercreekcir');
    // 12338 vs 12398 must stay distinct (the Raymond rental-vs-home case)
    expect(normStreet('12338 Amber Creek Cir')).not.toBe(normStreet('12398 Amber Creek Cir'));
  });

  test('addressKey distinguishes by unit + city + ZIP, not just street', () => {
    const a = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
    const b = { address_line1: '100 Main St', city: 'Sarasota', zip: '34236' };
    expect(addressKey(a)).not.toBe(addressKey(b));                              // same street, different city/ZIP
    const unitA = { address_line1: '100 Main St', address_line2: 'Unit A', city: 'Bradenton' };
    const unitB = { address_line1: '100 Main St', address_line2: 'Unit B', city: 'Bradenton' };
    expect(addressKey(unitA)).not.toBe(addressKey(unitB));                      // different unit
    // null/empty components don't change the key vs. omitting them
    expect(addressKey({ address_line1: '100 Main St', address_line2: null, city: 'Bradenton', zip: null }))
      .toBe(addressKey({ address_line1: '100 Main St', city: 'Bradenton' }));
  });

  test('addressKey collapses interchangeable unit designators (Apt/Unit/Ste/# → same), keeps real units distinct', () => {
    const base = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
    const k = (u) => addressKey({ ...base, address_line2: u });
    expect(k('Apt 4')).toBe(k('Unit 4'));   // interchangeable designators
    expect(k('Apt 4')).toBe(k('Ste 4'));
    expect(k('Apt 4')).toBe(k('#4'));
    expect(k('Apt 4')).toBe(k('4'));
    expect(k('Apt 4')).not.toBe(k('Apt 5'));               // different unit stays distinct
    expect(k('Apt 4')).not.toBe(addressKey(base));         // unit vs no-unit stays distinct
    // a unit EMBEDDED in line1 keys the same as the split (line2) form (word + '#')
    expect(addressKey({ address_line1: '100 Main St Apt 4', city: 'Bradenton', zip: '34205' }))
      .toBe(k('Apt 4'));
    expect(addressKey({ address_line1: '100 Main St #4', city: 'Bradenton', zip: '34205' }))
      .toBe(k('Apt 4'));
    // a bare unit "4" is NOT confused with a digit inside the house number
    expect(addressKey({ address_line1: '14 Main St', city: 'Bradenton', zip: '34205' }))
      .not.toBe(addressKey({ address_line1: '14 Main St', address_line2: '4', city: 'Bradenton', zip: '34205' }));
  });

  test('addressKey canonicalizes street suffixes (St==Street) but keeps streets distinct (St!=Ave)', () => {
    const base = { city: 'Bradenton', zip: '34205' };
    expect(addressKey({ ...base, address_line1: '123 Main St' }))
      .toBe(addressKey({ ...base, address_line1: '123 Main Street' }));   // abbreviation == expansion
    expect(addressKey({ ...base, address_line1: '123 Main St' }))
      .not.toBe(addressKey({ ...base, address_line1: '123 Main Ave' }));  // different street, NOT merged
  });

  test('unitKey collapses designators; streetEmbeddedUnitKey extracts the trailing unit', () => {
    // unit strings (line2): Apt/Unit/Ste/# variants of the SAME unit all collapse,
    // matching addressKey — so the classifier can't disagree with the dedup key
    expect(unitKey('Apt 4')).toBe('4');
    expect(unitKey('Unit 4')).toBe('4');
    expect(unitKey('#4')).toBe('4');
    expect(unitKey('4')).toBe('4');
    expect(unitKey('Apt 4')).toBe(unitKey('Unit 4'));   // the Codex case: Apt 4 == Unit 4
    expect(unitKey('Apt 4')).not.toBe(unitKey('Apt 5')); // real units stay distinct
    expect(unitKey('')).toBe('');
    // embedded in a one-line street: extract the trailing unit, but NEVER pull a
    // bare number out of the house number
    expect(streetEmbeddedUnitKey('100 Main St Apt 4')).toBe('4');
    expect(streetEmbeddedUnitKey('100 Main St #4')).toBe('4');
    expect(streetEmbeddedUnitKey('14 Main St')).toBe('');
    expect(unitKey('Apt 4')).toBe(streetEmbeddedUnitKey('100 Main St #4')); // line2 == embedded
  });

  test('normalizeOccupancy coerces unknown values', () => {
    for (const t of OCCUPANCY_TYPES) expect(normalizeOccupancy(t)).toBe(t);
    expect(normalizeOccupancy('rental')).toBe('unknown');
    expect(normalizeOccupancy(undefined)).toBe('unknown');
    expect(normalizeOccupancy(null)).toBe('unknown');
  });

  test('isNewAddress — true only for a street that is a NEW full address', () => {
    const existing = [{ address_line1: '12338 Ambercreek Cir', city: 'Lakewood Ranch', zip: '34211' }];
    expect(isNewAddress(existing, { address_line1: '12398 Amber Creek Circle', city: 'Lakewood Ranch', zip: '34211' })).toBe(true);  // his home — new
    expect(isNewAddress(existing, { address_line1: '12338 Amber Creek Cir', city: 'Lakewood Ranch', zip: '34211' })).toBe(false);    // same full address
    expect(isNewAddress(existing, { address_line1: '' })).toBe(false);                                                                // nothing to add
    // same street, DIFFERENT city = a new property (was a false-dup before)
    expect(isNewAddress([{ address_line1: '100 Main St', city: 'Bradenton' }], { address_line1: '100 Main St', city: 'Sarasota' })).toBe(true);
    expect(isNewAddress([], { address_line1: '12398 Amber Creek Cir' })).toBe(true);
    expect(isNewAddress(null, { address_line1: '1 Main St' })).toBe(true);
  });
});

describe('defaultOccupancyForContactRole (lazy primary backfill default)', () => {
  test('owner / unset → owner_occupied (residential majority)', () => {
    expect(defaultOccupancyForContactRole('owner')).toBe('owner_occupied');
    expect(defaultOccupancyForContactRole(null)).toBe('owner_occupied');
    expect(defaultOccupancyForContactRole(undefined)).toBe('owner_occupied');
  });
  test('non-owner roles never assert owner occupancy', () => {
    expect(defaultOccupancyForContactRole('property_manager')).toBe('rental_investment');
    expect(defaultOccupancyForContactRole('tenant')).toBe('unknown');
    expect(defaultOccupancyForContactRole(' TENANT ')).toBe('unknown');
  });
  test('every default is a known occupancy type', () => {
    for (const r of ['owner', 'property_manager', 'tenant', null]) {
      expect(OCCUPANCY_TYPES).toContain(defaultOccupancyForContactRole(r));
    }
  });
});

describe('soleActivePropertyId (GH #3699 r3: property anchor for the visit-group stamp)', () => {
  const { soleActivePropertyId } = require('../services/customer-properties');
  const connWith = (rows) => () => ({
    where: () => ({ limit: () => ({ select: async () => rows }) }),
  });

  test('exactly one active property is unambiguous', async () => {
    expect(await soleActivePropertyId('c1', connWith([{ id: 'p1' }]))).toBe('p1');
  });
  test('two or more active properties → null (office places those)', async () => {
    expect(await soleActivePropertyId('c1', connWith([{ id: 'p1' }, { id: 'p2' }]))).toBeNull();
  });
  test('no customer, or a read error → null (best-effort)', async () => {
    expect(await soleActivePropertyId(null, connWith([{ id: 'p1' }]))).toBeNull();
    expect(await soleActivePropertyId('c1', () => { throw new Error('down'); })).toBeNull();
  });

  // No row at all → the anchor backfills the lazily-created primary from the
  // customers mirror (prod 2026-09-07: 144 addressed customers, every lead /
  // public booking for them anchored to NULL) and returns it as the sole
  // property. Fake knex: `customer_properties` reads answer with `rows`
  // (then, after an insert, the inserted primary); `customers` answers with
  // the mirror row; `transaction(fn)` hands back the same fake (a savepoint).
  const fakeConn = ({ rows = [], customer = null, insertError = null, isTransaction = false } = {}) => {
    const state = { rows: [...rows], inserted: [], failures: [] };
    const conn = (table) => {
      if (table === 'customers') {
        return { where: () => ({ first: async () => customer }) };
      }
      const q = {
        where: () => q,
        limit: () => q,
        select: async () => state.rows,
        first: async () => state.rows.find((r) => r.is_primary) || null,
        insert: (row) => ({
          returning: async () => {
            if (insertError) throw insertError;
            const id = `p-new-${state.inserted.length + 1}`;
            state.inserted.push({ ...row, id });
            state.rows.push({ id, is_primary: true, active: true });
            return [{ id }];
          },
        }),
      };
      return q;
    };
    conn.isTransaction = isTransaction;
    conn.transaction = async (fn) => fn(conn);
    conn.state = state;
    return conn;
  };
  const addressed = { id: 'c1', address_line1: '100 Main St', city: 'Sampleville', state: 'FL', zip: '34200', contact_role: null };

  test('no property row + an on-file address → backfills the primary and anchors to it', async () => {
    const conn = fakeConn({ customer: addressed });
    expect(await soleActivePropertyId('c1', conn)).toBe('p-new-1');
    expect(conn.state.inserted).toHaveLength(1);
    expect(conn.state.inserted[0]).toMatchObject({
      customer_id: 'c1', is_primary: true, active: true, source: 'backfill',
      address_line1: '100 Main St', city: 'Sampleville', zip: '34200', occupancy_type: 'owner_occupied',
    });
  });
  test('backfill runs inside the caller transaction as a savepoint', async () => {
    const conn = fakeConn({ customer: addressed, isTransaction: true });
    expect(await soleActivePropertyId('c1', conn)).toBe('p-new-1');
  });
  test('no property row and no on-file address → nothing to backfill, null', async () => {
    const conn = fakeConn({ customer: { id: 'c1', address_line1: '' } });
    expect(await soleActivePropertyId('c1', conn)).toBeNull();
    expect(conn.state.inserted).toHaveLength(0);
  });
  test('an inactive-only primary is a deliberate deactivation — not recreated, null', async () => {
    const conn = fakeConn({ customer: addressed });
    conn.state.rows = []; // active read finds nothing …
    const inactive = { id: 'p-old', is_primary: true, active: false };
    const origConn = conn;
    // … but the primary existence check (no active filter) sees the row.
    const wrapped = (table) => {
      const q = origConn(table);
      if (table === 'customer_properties') q.first = async () => inactive;
      return q;
    };
    wrapped.isTransaction = false;
    wrapped.transaction = async (fn) => fn(wrapped);
    expect(await soleActivePropertyId('c1', wrapped)).toBeNull();
    expect(conn.state.inserted).toHaveLength(0);
  });
  test('a backfill failure degrades to null (best-effort, never throws into a booking)', async () => {
    const conn = fakeConn({ customer: addressed, insertError: Object.assign(new Error('boom'), { code: '42P01' }) });
    expect(await soleActivePropertyId('c1', conn)).toBeNull();
  });
  test('the primary race (23505) is not a sole property either — null', async () => {
    const conn = fakeConn({ customer: addressed, insertError: Object.assign(new Error('dup'), { code: '23505' }) });
    expect(await soleActivePropertyId('c1', conn)).toBeNull();
  });
});

describe('defaultRelationshipForContactRole (lazy primary backfill default)', () => {
  test('a property-manager profile\'s default address is a client\'s', () => {
    expect(defaultRelationshipForContactRole('property_manager')).toBe('managed_for_client');
    expect(defaultRelationshipForContactRole(' Property_Manager ')).toBe('managed_for_client');
  });
  test('no other role infers a relationship — the office records it', () => {
    for (const r of ['owner', 'tenant', 'primary', null, undefined, '']) {
      expect(defaultRelationshipForContactRole(r)).toBeNull();
    }
  });
});

describe('property relationships (constants/property-relationships)', () => {
  const { PROPERTY_RELATIONSHIPS, normalizeRelationship } = require('../constants/property-relationships');
  test('vocabulary carries the family case as a relationship, not an occupancy', () => {
    expect(PROPERTY_RELATIONSHIPS).toEqual(['own_home', 'rental_owned', 'family_home', 'managed_for_client']);
    expect(OCCUPANCY_TYPES).not.toContain('family');
  });
  test('normalizes: blank clears, known values pass, anything else is refused', () => {
    expect(normalizeRelationship(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeRelationship('')).toEqual({ ok: true, value: null });
    expect(normalizeRelationship(' Family_Home ')).toEqual({ ok: true, value: 'family_home' });
    expect(normalizeRelationship('family')).toEqual({ ok: false });
    expect(normalizeRelationship(42)).toEqual({ ok: false });
  });
});
