/**
 * 20260829000050 — visit→property linkage backfill + duplicate-property
 * retirement. Fake-knex harness in the style of the 20260825000010 test.
 * Pins: exactly-one-match linking (stamped OR mirror address), ambiguity
 * left alone, terminal visits untouched, single-property customers out of
 * scope, duplicate retirement only for unreferenced label-less 'unknown'
 * same-street+ZIP rows, idempotent up(), and value-guarded down().
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const { addressKey } = require('../services/customer-properties');
const migration = require('../models/migrations/20260829000050_backfill_visit_property_links');

const { STATE_KEY } = migration;

// Real-looking but fictional addresses; keys computed by the SAME helper the
// migration uses so the fixture can never drift from production normalization.
const A = { address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };
const B = { address_line1: '110 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };
const P = { address_line1: '20 Duplicate Way', address_line2: null, city: 'Nokomis', zip: '34275' };
const P2 = { address_line1: '20 Duplicate Way', address_line2: null, city: 'North Venice', zip: '34275' };
const prop = (id, customer_id, addr, extra = {}) => ({
  id, customer_id, active: true, is_primary: false, label: 'Home', occupancy_type: 'owner_occupied',
  ...addr, address_key: addressKey(addr), ...extra,
});

function seedDb() {
  return {
    customers: [
      { id: 'c1', ...A },
      { id: 'c2', ...A },
      { id: 'c3', ...P },
    ],
    customer_properties: [
      prop('p1', 'c1', A, { is_primary: true, label: 'Primary' }),
      prop('p2', 'c1', B, { label: 'Rental' }),
      prop('p-single', 'c2', A, { is_primary: true }),
      prop('p3', 'c3', P, { is_primary: true, label: 'Primary' }),
      // Same street + ZIP as the primary, different city spelling, no label,
      // occupancy unknown, referenced by nothing → retire.
      prop('p4', 'c3', P2, { label: null, occupancy_type: 'unknown' }),
      // Same shape but a visit references it → keep.
      prop('p5', 'c3', { ...P2, address_line2: 'B' }, { label: null, occupancy_type: 'unknown' }),
    ],
    scheduled_services: [
      // stamped address = A → p1
      { id: 'v-stamped', customer_id: 'c1', status: 'pending', property_id: null, service_address_line1: A.address_line1, service_address_line2: null, service_address_city: A.city, service_address_zip: A.zip },
      // no stamp, customer mirror = A → p1
      { id: 'v-mirror', customer_id: 'c1', status: 'confirmed', property_id: null, service_address_line1: null },
      // stamped address matches nothing → untouched
      { id: 'v-nomatch', customer_id: 'c1', status: 'pending', property_id: null, service_address_line1: '999 Elsewhere Rd', service_address_city: 'Venice', service_address_zip: '34293' },
      // terminal → untouched even though it would match
      { id: 'v-done', customer_id: 'c1', status: 'completed', property_id: null, service_address_line1: A.address_line1, service_address_city: A.city, service_address_zip: A.zip },
      // already linked → untouched
      { id: 'v-linked', customer_id: 'c1', status: 'pending', property_id: 'p2', service_address_line1: B.address_line1, service_address_city: B.city, service_address_zip: B.zip },
      // single-property customer → out of scope
      { id: 'v-single', customer_id: 'c2', status: 'pending', property_id: null, service_address_line1: A.address_line1, service_address_city: A.city, service_address_zip: A.zip },
      // references p5 so p5 must survive leg B
      { id: 'v-ref-p5', customer_id: 'c3', status: 'pending', property_id: 'p5', service_address_line1: null },
    ],
    estimates: [],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const ins = [];
    const notIns = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v))
      && ins.every((c) => c.vals.includes(r[c.col]))
      && notIns.every((c) => !c.vals.includes(r[c.col]));
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, vals) { ins.push({ col, vals }); return q; },
      whereNotIn(col, vals) { notIns.push({ col, vals }); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      async select(...cols) {
        return rowsNow().filter(match).map((r) => {
          if (!cols.length) return { ...r };
          const o = {}; cols.forEach((c) => { o[c] = r[c] === undefined ? null : r[c]; }); return o;
        });
      },
      async first() { const h = rowsNow().find(match); return h ? { ...h } : undefined; },
      async update(patch) {
        const hits = rowsNow().filter(match);
        if (table === 'customer_properties' && patch.active === true) {
          // emulate customer_properties_customer_address_uniq WHERE active
          for (const h of hits) {
            const clash = rowsNow().some((o) => o !== h && o.active && o.customer_id === h.customer_id && o.address_key === h.address_key);
            if (clash) throw new Error('duplicate key value violates unique constraint "customer_properties_customer_address_uniq"');
          }
        }
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      async del() { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      async insert(row) { (db[table] = rowsNow()).push({ ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && (db[t].length === 0 || c in db[t][0] || ['property_id'].includes(c)),
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const property = (db, id) => db.customer_properties.find((r) => r.id === id);
const state = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('20260829000050 backfill visit property links', () => {
  test('up() links open unlinked visits to the single matching property (stamp or mirror)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBe('p1');
    expect(visit(db, 'v-mirror').property_id).toBe('p1');
    expect(state(db).linked).toEqual({ 'v-stamped': 'p1', 'v-mirror': 'p1' });
  });

  test('up() leaves no-match, terminal, already-linked and single-property visits alone', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-nomatch').property_id).toBeNull();
    expect(visit(db, 'v-done').property_id).toBeNull();
    expect(visit(db, 'v-linked').property_id).toBe('p2');
    expect(visit(db, 'v-single').property_id).toBeNull();
  });

  test('up() leaves an AMBIGUOUS visit alone (two properties share the stamped key)', async () => {
    const db = seedDb();
    // Second active property with the same full key as p1 — cannot exist in
    // prod (unique index) but proves the exactly-one rule is enforced.
    db.customer_properties.push(prop('p1-dup', 'c1', A, { label: 'Twin' }));
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
    expect(state(db).linked).toEqual({});
  });

  test('up() retires the unreferenced same-street duplicate and keeps the referenced one', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(property(db, 'p4').active).toBe(false);
    expect(property(db, 'p4').updated_at).toBe('NOW');
    expect(property(db, 'p5').active).toBe(true);
    expect(property(db, 'p3').active).toBe(true);
    expect(state(db).deactivated).toEqual(['p4']);
  });

  test('up() does not retire a labeled, blank-labeled, or non-unknown duplicate', async () => {
    const db = seedDb();
    property(db, 'p4').label = 'Guest house';
    await migration.up(fakeKnex(db));
    expect(property(db, 'p4').active).toBe(true);
    // Non-NULL but blank is still intent (strictly-NULL rule).
    const db1 = seedDb();
    property(db1, 'p4').label = '';
    await migration.up(fakeKnex(db1));
    expect(property(db1, 'p4').active).toBe(true);
    const db2 = seedDb();
    property(db2, 'p4').occupancy_type = 'rental_investment';
    await migration.up(fakeKnex(db2));
    expect(property(db2, 'p4').active).toBe(true);
  });

  test('up() is idempotent once the state row exists', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-stamped').property_id = null; // admin cleared it after the run
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
  });

  test('down() clears only links still carrying the written property and revives retired rows', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-mirror').property_id = 'p2'; // admin re-pointed it since
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
    expect(visit(db, 'v-mirror').property_id).toBe('p2');
    expect(property(db, 'p4').active).toBe(true);
    expect(db.system_settings.find((r) => r.key === STATE_KEY)).toBeUndefined();
  });

  test('down() leaves a retired row retired when an equal-key active row appeared since', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    db.customer_properties.push(prop('p4-new', 'c3', P2, { label: 'Re-added by admin', occupancy_type: 'rental_investment' }));
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
    expect(property(db, 'p4').active).toBe(false);
  });

  test('up()/down() are no-ops without the tables / without a state row', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingTables: ['customer_properties'] }));
    expect(db.system_settings).toEqual([]);
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
  });
});
