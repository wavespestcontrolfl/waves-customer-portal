// Real PostgreSQL transactions (rolled back); the county lookup is a stub.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
const { randomUUID } = require('node:crypto');
const { resolvePropertyNeighborhood, fileNeighborhoodCode } = require('../services/neighborhood-access');
const migration = require('../models/migrations/20261001190000_neighborhood_access');

jest.setTimeout(30000);
postgres('neighborhood access directory', () => {
  let database;
  let trx;
  let customerId;

  const property = async (overrides = {}) => {
    const id = randomUUID();
    await trx('customer_properties').insert({
      id, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied',
      is_primary: false, address_line1: '100 Synthetic Way', city: 'Lakewood Ranch',
      zip: '34202', latitude: 27.4, longitude: -82.35, active: true, address_key: id, ...overrides,
    });
    return trx('customer_properties').where({ id }).first();
  };
  // The parcel under the pin carries the property's own house number + ZIP.
  const stub = (subdivision, county = 'Manatee', situsAddress = '100 SYNTHETIC WAY') => async () => ({
    county, subdivision, situsAddress, situsZip: '34202',
  });

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Gate', phone: '+12025550188', email: `${customerId}@example.invalid` });
  });
  afterEach(() => trx.rollback());
  afterAll(() => database.destroy());

  test('two phases of one development link to one neighborhood that remembers both roll names', async () => {
    const a = await property();
    const b = await property();
    const ra = await resolvePropertyNeighborhood(a, { conn: trx, lookup: stub('OAKWOOD GLEN PH IV SUBPH 4A & 4B PB66/57') });
    const rb = await resolvePropertyNeighborhood(b, { conn: trx, lookup: stub('OAKWOOD GLEN PH II PB60/1') });
    expect(ra.status).toBe('linked');
    expect(rb.neighborhood.id).toBe(ra.neighborhood.id);
    expect(ra.neighborhood.inserted).toBe(true);
    expect(rb.neighborhood.inserted).toBe(false);
    const n = await trx('neighborhoods').where({ id: ra.neighborhood.id }).first();
    expect(n.name).toBe('Oakwood Glen');
    expect(n.subdivision_names).toEqual(['OAKWOOD GLEN PH IV SUBPH 4A & 4B PB66/57', 'OAKWOOD GLEN PH II PB60/1']);
    const linked = await trx('customer_properties').whereIn('id', [a.id, b.id]).pluck('neighborhood_id');
    expect(linked).toEqual([n.id, n.id]);
  });

  test('a numeric roll code records the raw value but links nothing', async () => {
    const p = await property();
    const r = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('3340', 'Sarasota') });
    expect(r.status).toBe('no_name');
    const row = await trx('customer_properties').where({ id: p.id }).first();
    expect(row.neighborhood_id).toBeNull();
    expect(row.county_subdivision).toBe('3340');
    expect(row.neighborhood_checked_at).not.toBeNull();
  });

  test('an office pick is never overwritten by the county roll', async () => {
    const [office] = await trx('neighborhoods')
      .insert({ name: 'Office Pick', county: 'Sarasota', match_key: `sarasota|office pick ${customerId}`, source: 'office' })
      .returning('id');
    const p = await property({ neighborhood_id: office.id, neighborhood_source: 'office' });
    const r = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('OAKWOOD GLEN PH IV PB66/57') });
    expect(r.status).toBe('office_pick');
    expect((await trx('customer_properties').where({ id: p.id }).first()).neighborhood_id).toBe(office.id);
  });

  test('the same code from two neighbors files once; a different code flags both for the office', async () => {
    const p = await property();
    const { neighborhood } = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('BRAMBLE CREEK PH I PB1/1') });
    const base = { neighborhoodId: neighborhood.id, source: 'backfill', sourceCustomerId: customerId };

    expect((await fileNeighborhoodCode(trx, { ...base, value: '#1111' })).status).toBe('filed');
    expect((await fileNeighborhoodCode(trx, { ...base, value: '#1111' })).status).toBe('duplicate');
    expect((await fileNeighborhoodCode(trx, { ...base, value: '#2222' })).status).toBe('filed_conflict');

    const rows = await trx('neighborhood_access').where({ neighborhood_id: neighborhood.id }).orderBy('code');
    expect(rows.map((r) => [r.code, r.access_type, r.status])).toEqual([
      ['#1111', 'keypad', 'needs_confirm'],
      ['#2222', 'keypad', 'needs_confirm'],
    ]);
  });

  test.each([
    ['confirmed first', [false, true]],
    ['unconfirmed first', [true, false]],
  ])('an unconfirmed copy of a live code ends needs_confirm either way (%s)', async (_label, order) => {
    const p = await property();
    const { neighborhood } = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('VILLA SAMPLE PH I PB2/2') });
    const results = [];
    for (const unconfirmed of order) {
      results.push(await fileNeighborhoodCode(trx, {
        neighborhoodId: neighborhood.id, value: '#3333', source: 'backfill', unconfirmed,
      }));
    }
    const rows = await trx('neighborhood_access').where({ neighborhood_id: neighborhood.id });
    expect(rows.map((r) => r.status)).toEqual(['needs_confirm']);
    // Only a row this call moved off active is reported (for the rollback).
    expect(results[1].flagged.map((f) => f.id)).toEqual(order[0] ? [] : [rows[0].id]);
  });

  test('an alias append reports the names it replaced', async () => {
    const a = await property();
    const b = await property();
    const first = await resolvePropertyNeighborhood(a, { conn: trx, lookup: stub('STONEFIELD PHASE I PB51/178') });
    const { stored } = await trx('neighborhoods').where({ id: first.neighborhood.id }).first(trx.raw('updated_at::text AS stored'));
    const r = await resolvePropertyNeighborhood(b, { conn: trx, lookup: stub('STONEFIELD PHASE II PB52/1') });
    expect(r.wrote).toBe(true);
    expect(r.neighborhood.prior.subdivision_names).toEqual(['STONEFIELD PHASE I PB51/178']);
    // Exactly the stored text (microseconds intact), so the rollback restores it.
    expect(r.neighborhood.prior.updated_at).toBe(stored);
  });

  test('a pin that lands on another house links nothing and writes nothing', async () => {
    const p = await property();
    const r = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('OAKWOOD GLEN PH IV PB66/57', 'Manatee', '700 OTHER ST') });
    expect(r).toEqual({ status: 'situs_mismatch', wrote: false });
    const row = await trx('customer_properties').where({ id: p.id }).first();
    expect([row.neighborhood_id, row.neighborhood_checked_at]).toEqual([null, null]);
  });

  test('free text files as an instruction for the office to confirm, once', async () => {
    const p = await property();
    const { neighborhood } = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('HARBOR SAMPLE PHASE 1 PB43/162') });
    const base = { neighborhoodId: neighborhood.id, source: 'backfill', value: 'Text the owner on arrival; north gate only' };
    expect((await fileNeighborhoodCode(trx, base)).status).toBe('filed');
    expect((await fileNeighborhoodCode(trx, base)).status).toBe('duplicate');
    const row = await trx('neighborhood_access').where({ neighborhood_id: neighborhood.id }).first();
    expect([row.access_type, row.code, row.instructions, row.status]).toEqual(['instructions', null, base.value, 'needs_confirm']);
  });

  test('two connections filing different codes at once both end needs_confirm', async () => {
    // Committed rows on two real connections (the per-test trx can't show a
    // cross-transaction race); cleaned up by the cascade below.
    const [n] = await database('neighborhoods')
      .insert({ name: 'Race', county: 'Manatee', match_key: `manatee|race ${randomUUID()}`, source: 'county' })
      .returning('id');
    try {
      const t1 = await database.transaction();
      const t2 = await database.transaction();
      const first = fileNeighborhoodCode(t1, { neighborhoodId: n.id, value: '1111', source: 'backfill' });
      await first;
      // t2 blocks on the neighborhood lock until t1 commits.
      const second = fileNeighborhoodCode(t2, { neighborhoodId: n.id, value: '2222', source: 'backfill' });
      await t1.commit();
      expect((await second).status).toBe('filed_conflict');
      await t2.commit();
      const rows = await database('neighborhood_access').where({ neighborhood_id: n.id }).orderBy('code');
      expect(rows.map((r) => [r.code, r.status])).toEqual([['1111', 'needs_confirm'], ['2222', 'needs_confirm']]);
    } finally {
      await database('neighborhoods').where({ id: n.id }).del();
    }
  });

  test('the backfill claim writes a property once; a second run finds it already checked', async () => {
    const p = await property();
    const lookup = stub('OAKWOOD GLEN PH IV PB66/57');
    const first = await resolvePropertyNeighborhood(p, { conn: trx, lookup, onlyUnchecked: true });
    const second = await resolvePropertyNeighborhood(p, { conn: trx, lookup, onlyUnchecked: true });
    expect([first.status, first.wrote]).toEqual(['linked', true]);
    expect(second).toEqual({ status: 'already_checked', wrote: false });
  });

  test('an address move between the lookup and the claim discards the stale lookup', async () => {
    const p = await property();
    // The snapshot the lookup ran on; the row moves before the claim.
    await trx('customer_properties').where({ id: p.id }).update({ address_line1: '200 Moved Way', latitude: null, longitude: null });
    const r = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('OAKWOOD GLEN PH IV PB66/57'), onlyUnchecked: true });
    expect(r).toEqual({ status: 'stale_lookup', wrote: false });
    expect(await trx('neighborhoods').where('match_key', 'manatee|oakwood glen').first()).toBeUndefined();
  });

  test.each([
    ['a street move clears the link', { address_line1: '200 Moved Way' }, {}, null],
    ['a unit-only edit keeps it', { address_line2: 'Unit 4' }, { explicitLine2: true }, 'kept'],
    ['a unit-only edit keeps it even when the caller drops coords', { address_line2: 'Unit 4' }, { explicitLine2: true, preserveCoords: false }, 'kept'],
    ['a format-only edit (city case, ZIP+4) keeps it', { city: 'LAKEWOOD RANCH', zip: '34202-1234' }, {}, 'kept'],
    ['a new ZIP clears it', { zip: '34211' }, {}, null],
    ['a directional spelled out vs abbreviated keeps it', { address_line1: '100 Synthetic Way E' }, {}, 'kept', '100 Synthetic Way East'],
    ['a different directional clears it', { address_line1: '100 Synthetic Way W' }, {}, null, '100 Synthetic Way East'],
    ['a suffix spelled out vs abbreviated keeps it', { address_line1: '100 Synthetic Cv' }, {}, 'kept', '100 Synthetic Cove'],
    ['a different street name clears it', { address_line1: '100 Other Cove' }, {}, null, '100 Synthetic Cove'],
    ['a new house number on the same street clears it', { address_line1: '900 Synthetic Cove' }, {}, null, '100 Synthetic Cove'],
  ])('%s', async (_label, change, opts, expected, startLine = '100 Synthetic Way') => {
    const { syncPrimaryAddress } = require('../services/customer-properties');
    const p = await property({ is_primary: true, address_line1: startLine });
    const { neighborhood } = await resolvePropertyNeighborhood(p, { conn: trx, lookup: stub('OAKWOOD GLEN PH IV PB66/57', 'Manatee', startLine.toUpperCase()) });
    await trx('customers').where({ id: customerId }).update({ address_line1: startLine, city: 'Lakewood Ranch', zip: '34202', ...change });
    const customer = await trx('customers').where({ id: customerId }).first();
    await syncPrimaryAddress(customer, trx, opts);
    const row = await trx('customer_properties').where({ id: p.id }).first();
    expect(row.neighborhood_id).toBe(expected ? neighborhood.id : null);
    expect(row.neighborhood_checked_at === null).toBe(!expected);
  });

  test('the per-column guard completes a partially provisioned schema', async () => {
    const guard = require('../models/migrations/20261001190100_neighborhood_access_property_columns');
    const indexGuard = require('../models/migrations/20261001190200_neighborhood_access_index_guard');
    // Dropping neighborhood_id also drops its index; the two guards restore both.
    await trx.schema.alterTable('customer_properties', (t) => { t.dropColumn('neighborhood_id'); t.dropColumn('neighborhood_checked_at'); });
    await guard.up(trx);
    await indexGuard.up(trx);
    await guard.up(trx);
    await indexGuard.up(trx);
    for (const col of ['neighborhood_id', 'neighborhood_source', 'county_subdivision', 'neighborhood_checked_at']) {
      expect(await trx.schema.hasColumn('customer_properties', col)).toBe(true);
    }
    const { rows } = await trx.raw("SELECT 1 FROM pg_indexes WHERE indexname = 'customer_properties_neighborhood_id_index'");
    expect(rows).toHaveLength(1);
    // …so the original's down() (which drops that index by name) still works
    // (the later filings ledger references neighborhoods: it goes first, as
    // a real rollback would take it).
    await require('../models/migrations/20261002100000_neighborhood_access_filings').down(trx);
    await migration.down(trx);
    expect(await trx.schema.hasColumn('customer_properties', 'neighborhood_id')).toBe(false);
  });

  test('migration up is idempotent and down removes everything it added', async () => {
    await migration.up(trx);
    // The later filings ledger references neighborhoods; a real rollback takes it first.
    await require('../models/migrations/20261002100000_neighborhood_access_filings').down(trx);
    await migration.down(trx);
    expect(await trx.schema.hasTable('neighborhood_access')).toBe(false);
    expect(await trx.schema.hasColumn('customer_properties', 'neighborhood_id')).toBe(false);
    await migration.up(trx);
    await migration.up(trx);
    expect(await trx.schema.hasTable('neighborhoods')).toBe(true);
  });
});
