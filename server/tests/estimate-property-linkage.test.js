jest.mock('../models/db', () => jest.fn());

const {
  parseEstimateAddress,
} = require('../services/estimate-property-linkage');
const {
  ensureEstimateGroupId,
  resolveEstimatePropertyLinkage,
} = require('../services/admin-estimate-persistence');

describe('parseEstimateAddress', () => {
  test('parses the Google Places formatted shape', () => {
    expect(parseEstimateAddress('123 Main St, Bradenton, FL 34205')).toEqual({
      address_line1: '123 Main St',
      address_line2: null,
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
      partial: false,
    });
  });

  test('strips a trailing USA and tolerates ZIP+4', () => {
    expect(parseEstimateAddress('123 Main St, Bradenton, FL 34205-1234, USA')).toEqual({
      address_line1: '123 Main St',
      address_line2: null,
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
      partial: false,
    });
  });

  test('canonicalizes a leading unit prefix into address_line2 (codex r6)', () => {
    // Existing customer_properties rows keep the unit in line 2, and
    // addressKey preserves token order — the split keeps one property from
    // producing two different keys.
    expect(parseEstimateAddress('Unit 4, 100 Beach Rd, Venice, FL 34285')).toEqual({
      address_line1: '100 Beach Rd',
      address_line2: 'Unit 4',
      city: 'Venice',
      state: 'FL',
      zip: '34285',
      partial: false,
    });
  });

  test('parses the ONE-comma shape "street, City ST ZIP" (codex #3431 r1)', () => {
    // Without this, the whole trailing segment collapsed into a partial
    // street token embedding the locality — scope keys built from it could
    // never equal a structured key for the SAME property, so adoption and
    // the duplicate-series guard mis-compared.
    expect(parseEstimateAddress('1 Test St, Bradenton FL 34208')).toEqual({
      address_line1: '1 Test St',
      address_line2: null,
      city: 'Bradenton',
      state: 'FL',
      zip: '34208',
      partial: false,
    });
  });

  test('one-comma shape keeps multi-word cities intact', () => {
    expect(parseEstimateAddress('2 Oak Ave, North Port FL 34287')).toEqual({
      address_line1: '2 Oak Ave',
      address_line2: null,
      city: 'North Port',
      state: 'FL',
      zip: '34287',
      partial: false,
    });
  });

  test('unparseable text falls back to partial with the whole line as street', () => {
    expect(parseEstimateAddress('the yellow house behind the marina')).toEqual({
      address_line1: 'the yellow house behind the marina',
      address_line2: null,
      city: '',
      state: 'FL',
      zip: '',
      partial: true,
    });
  });

  test('blank input returns null', () => {
    expect(parseEstimateAddress('')).toBeNull();
    expect(parseEstimateAddress(null)).toBeNull();
  });
});

describe('resolveEstimatePropertyLinkage', () => {
  const PROPERTY_ID = '11111111-2222-3333-4444-555555555555';
  const CUSTOMER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function makeDb(propertyRow) {
    return (table) => ({
      where() {
        return {
          first: async () => (table === 'customer_properties' ? propertyRow : null),
        };
      },
    });
  }

  test('returns no keys when the body carries neither field', async () => {
    await expect(resolveEstimatePropertyLinkage(makeDb(null), {})).resolves.toEqual({});
  });

  test('explicit nulls clear both columns', async () => {
    await expect(
      resolveEstimatePropertyLinkage(makeDb(null), { propertyId: null, estimateGroupId: null }),
    ).resolves.toEqual({ property_id: null, estimate_group_id: null });
  });

  test('non-uuid propertyId is a 400', async () => {
    await expect(
      resolveEstimatePropertyLinkage(makeDb(null), { propertyId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('unknown or inactive property is a 404', async () => {
    await expect(
      resolveEstimatePropertyLinkage(makeDb(null), { propertyId: PROPERTY_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      resolveEstimatePropertyLinkage(
        makeDb({ id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: false }),
        { propertyId: PROPERTY_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("another customer's property is a 400", async () => {
    await expect(
      resolveEstimatePropertyLinkage(
        makeDb({ id: PROPERTY_ID, customer_id: 'ffffffff-0000-0000-0000-000000000000', active: true }),
        { propertyId: PROPERTY_ID, customerId: CUSTOMER_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a valid owned property and group id pass through as write fields', async () => {
    const GROUP_ID = '99999999-8888-7777-6666-555555555555';
    await expect(
      resolveEstimatePropertyLinkage(
        makeDb({ id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: true }),
        { propertyId: PROPERTY_ID, customerId: CUSTOMER_ID, estimateGroupId: GROUP_ID },
      ),
    ).resolves.toEqual({ property_id: PROPERTY_ID, estimate_group_id: GROUP_ID });
  });
});

describe('ensureEstimateGroupId', () => {
  const ANCHOR_ID = '11111111-2222-3333-4444-555555555555';
  const MINTED = '99999999-8888-7777-6666-555555555555';

  function makeTrx(anchorRow) {
    const updates = [];
    const trx = (table) => ({
      where(clause) {
        return {
          forUpdate() { return this; },
          first: async () => (table === 'estimates' && clause.id === anchorRow?.id ? anchorRow : null),
          update: async (patch) => {
            updates.push({ table, clause, patch });
            return 1;
          },
        };
      },
    });
    return { trx, updates };
  }

  const CUSTOMER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const SAME_CUSTOMER_SIBLING = { customer_id: CUSTOMER_ID };

  test('mints and persists a group id for an ungrouped anchor', async () => {
    const { trx, updates } = makeTrx({ id: ANCHOR_ID, estimate_group_id: null, customer_id: CUSTOMER_ID });
    await expect(ensureEstimateGroupId(trx, ANCHOR_ID, SAME_CUSTOMER_SIBLING, () => MINTED)).resolves.toBe(MINTED);
    expect(updates).toEqual([
      { table: 'estimates', clause: { id: ANCHOR_ID }, patch: { estimate_group_id: MINTED } },
    ]);
  });

  test('returns the existing group id without writing', async () => {
    const existing = '12121212-3434-5656-7878-909090909090';
    const { trx, updates } = makeTrx({ id: ANCHOR_ID, estimate_group_id: existing, customer_id: CUSTOMER_ID });
    await expect(ensureEstimateGroupId(trx, ANCHOR_ID, SAME_CUSTOMER_SIBLING, () => MINTED)).resolves.toBe(existing);
    expect(updates).toEqual([]);
  });

  test('missing anchor is a 404, malformed anchor id a 400', async () => {
    const { trx } = makeTrx(null);
    await expect(ensureEstimateGroupId(trx, ANCHOR_ID)).rejects.toMatchObject({ statusCode: 404 });
    await expect(ensureEstimateGroupId(trx, 'nope')).rejects.toMatchObject({ statusCode: 400 });
  });

  // Same-customer guard (codex #3244 r1): the group publishes under one
  // bearer link, so grouping estimates from different customers would leak
  // sibling tokens/addresses and cross-accept accounts.
  test('rejects a sibling with a different customer_id (400)', async () => {
    const { trx, updates } = makeTrx({ id: ANCHOR_ID, estimate_group_id: null, customer_id: CUSTOMER_ID });
    await expect(
      ensureEstimateGroupId(trx, ANCHOR_ID, { customer_id: '99999999-0000-1111-2222-333333333333' }, () => MINTED),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toEqual([]);
  });

  test('lead-only estimates group on matching contact, reject on mismatch', async () => {
    const anchor = {
      id: ANCHOR_ID,
      estimate_group_id: null,
      customer_id: null,
      customer_phone: '(941) 555-0100',
      customer_email: 'lead@example.com',
    };
    const { trx } = makeTrx(anchor);
    await expect(
      ensureEstimateGroupId(trx, ANCHOR_ID, { customer_id: null, customer_phone: '9415550100' }, () => MINTED),
    ).resolves.toBe(MINTED);
    const { trx: trx2 } = makeTrx({ ...anchor });
    await expect(
      ensureEstimateGroupId(trx2, ANCHOR_ID, { customer_id: null, customer_phone: '9415559999', customer_email: 'other@example.com' }, () => MINTED),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
