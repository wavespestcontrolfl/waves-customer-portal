/**
 * 20261002090000 — one house, one address key. Fake-knex harness.
 * Pins: every table is locked before the first read; one house spelled two
 * ways folds into the primary with its references (a unique refusal leaves
 * that reference behind); distinct houses, units of one building and
 * inactive rows are untouched; every stored key becomes the live key; open
 * property-role cards are re-keyed / re-pointed / resolved; re-runs are
 * no-ops; down() reverses exactly what up() did; the frozen key copies match
 * the live helper (new) and the pre-2026-10-02 format (legacy).
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const { addressKey } = require('../services/customer-properties');
const migration = require('../models/migrations/20261002090000_one_house_one_address_key');

const { legacyKey, newKey } = migration;

function fakeKnex(db) {
  const log = (db.__log = db.__log || []);
  const rowsOf = (t) => (db[t] = db[t] || []);
  const knex = (table) => {
    const preds = [];
    const match = (r) => preds.every((p) => p(r));
    const q = {
      where(obj) { preds.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return q; },
      whereIn(col, vals) { preds.push((r) => vals.includes(r[col])); return q; },
      max(expr) {
        const [col, , alias] = expr.split(' ');
        return { first: async () => { const vals = rowsOf(table).filter(match).map((r) => r[col]); return { [alias]: vals.length ? Math.max(...vals) : null }; } };
      },
      async select() { log.push(`select ${table}`); return rowsOf(table).filter(match).map((r) => ({ ...r })); },
      whereNotNull(col) { preds.push((r) => r[col] != null); return q; },
      async first() { const h = rowsOf(table).find(match); return h ? { ...h } : undefined; },
      async update(patch) {
        log.push(`update ${table}`);
        const hits = rowsOf(table).filter(match);
        for (const h of hits) {
          const next = { ...h, ...patch };
          if (table === 'customer_properties' && next.active && next.address_key
            && rowsOf(table).some((o) => o !== h && o.active && o.customer_id === next.customer_id && o.address_key === next.address_key)) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          if (table === 'property_notification_prefs' && rowsOf(table).some((o) => o !== h && o.property_id === next.property_id)) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
        }
        hits.forEach((h) => Object.assign(h, patch));
        return hits.length;
      },
      async del() { const hits = rowsOf(table).filter(match); db[table] = rowsOf(table).filter((r) => !hits.includes(r)); return hits.length; },
      async insert(row) { rowsOf(table).push({ ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t in db,
    hasColumn: async (t, c) => t in db && (c === 'property_id' || t === 'customer_properties'),
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql) => { log.push(sql); };
  knex.transaction = async (fn) => fn(knex);
  return knex;
}

// Fictional addresses, stored with pre-migration keys (they coexist).
const prop = (id, customer_id, addr, extra = {}) => ({
  id, customer_id, active: true, is_primary: false, created_at: '2026-09-01T00:00:00Z',
  address_line2: null, ...addr, address_key: legacyKey({ address_line2: null, ...addr }), ...extra,
});
const A1 = { address_line1: '200 Example Gln', city: 'Parrish', zip: '34219' };
const A2 = { address_line1: '200 Example Glen', city: 'Parrish', zip: '34219' };
const B1 = { address_line1: '400 Test Creek Ct', city: 'Duette', zip: '34219' };
const B2 = { address_line1: '400 Test Creek Court', city: 'Parrish', zip: '34219' };
const C1 = { address_line1: '500 Demo Ln', city: 'Venice', zip: '34285' };
const C2 = { address_line1: '510 Demo Ln', city: 'Venice', zip: '34285' };

function seed() {
  return {
    customer_properties: [
      prop('keep-a', 'c1', A1, { is_primary: true }),
      prop('dup-a', 'c1', A2, { created_at: '2026-09-01T00:00:01Z' }),
      prop('keep-b', 'c2', B1, { is_primary: true }),
      prop('dup-b', 'c2', B2),
      prop('other-b', 'c2', { address_line1: '402 Test Creek Ct', city: 'Parrish', zip: '34219' }),
      prop('old-b', 'c2', { address_line1: '400 Test Creek Ct', city: 'Parrish', zip: '34219' }, { active: false }),
      prop('apt-4', 'c3', { address_line1: '100 Main St Apt 4', address_line2: 'Building A', city: 'Venice', zip: '34285' }, { is_primary: true }),
      prop('apt-5', 'c3', { address_line1: '100 Main St Apt 5', address_line2: 'Building A', city: 'Venice', zip: '34285' }),
      prop('pt-house', 'c5', { address_line1: '700 Demo Gln', city: 'Parrish', zip: '34219' }, { is_primary: true }),
      prop('pt-unit', 'c5', { address_line1: '700 Demo Gln Unit PT', city: 'Parrish', zip: '34219' }),
      prop('ab-unit', 'c5', { address_line1: '700 Demo Gln Unit AB', city: 'Parrish', zip: '34219' }),
      prop('home-c', 'c4', C1, { is_primary: true }),
      prop('rental-c', 'c4', C2),
    ],
    scheduled_services: [
      { id: 'v1', property_id: 'dup-a' },
      { id: 'v2', property_id: 'other-b' },
      { id: 'v-apt5', property_id: 'apt-5' },
    ],
    estimates: [{ id: 'e1', property_id: 'dup-a' }],
    property_notification_prefs: [
      { id: 'n-keep', property_id: 'keep-a' },
      { id: 'n-dup', property_id: 'dup-a' },
    ],
    triage_items: [
      // a flip onto the duplicate copy: nothing left once merged
      { id: 'card-flip', reason_code: 'property_role_confirm', status: 'open', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'primary_flip', new_primary_property_id: 'dup-a', new_primary_address_key: legacyKey(A2), old_primary_property_id: 'keep-a', old_primary_address_key: legacyKey(A1) },
      ] }) },
      // an occupancy change on a copy plus a still-valid flip elsewhere
      { id: 'card-mixed', reason_code: 'property_role_confirm', status: 'open', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'occupancy_change', property_id: 'dup-b', address_key: legacyKey(B2), current_occupancy: 'unknown', proposed_occupancy: 'owner_occupied' },
      ] }) },
      { id: 'card-flip-c', reason_code: 'property_role_confirm', status: 'open', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'primary_flip', new_primary_property_id: 'rental-c', new_primary_address_key: legacyKey(C2), old_primary_property_id: 'home-c', old_primary_address_key: 'stale-staged-key' },
      ] }) },
      { id: 'card-closed', reason_code: 'property_role_confirm', status: 'resolved', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'occupancy_change', property_id: 'dup-a', address_key: legacyKey(A2) },
      ] }) },
    ],
    system_settings: [],
  };
}
const row = (db, id) => db.customer_properties.find((r) => r.id === id);
const card = (db, id) => db.triage_items.find((r) => r.id === id);
const proposalsOf = (db, id) => JSON.parse(card(db, id).payload).property_role_proposals;

describe('20261002090000 one house, one address key', () => {
  test('locks every table it touches before its first read', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(db.__log[0]).toBe("SET LOCAL lock_timeout = '20s'");
    expect(db.__log[1]).toBe('LOCK TABLE customer_properties, scheduled_services, estimates, property_notification_prefs, triage_items IN SHARE ROW EXCLUSIVE MODE');
    expect(db.__log[2]).toBe('select customer_properties');
  });

  test('folds one house spelled two ways into the primary, moving its references', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(row(db, 'dup-a')).toMatchObject({ active: false, is_primary: false });
    expect(row(db, 'dup-b')).toMatchObject({ active: false, is_primary: false });
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('keep-a');
    expect(db.estimates[0].property_id).toBe('keep-a');
    // the keeper already has prefs (unique on property_id): the copy's stay as history
    expect(db.property_notification_prefs.find((p) => p.id === 'n-dup').property_id).toBe('dup-a');
    // a different house, two units of one building, and an inactive row are untouched
    expect(row(db, 'other-b').active).toBe(true);
    expect(row(db, 'apt-5').active).toBe(true);
    expect(row(db, 'pt-unit').active && row(db, 'ab-unit').active).toBe(true);
    expect(db.scheduled_services.find((v) => v.id === 'v-apt5').property_id).toBe('apt-5');
    expect(row(db, 'keep-a').is_primary && row(db, 'keep-b').is_primary).toBe(true);
  });

  test('stores the live key on every row, retired ones included', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    for (const r of db.customer_properties) expect(r.address_key).toBe(addressKey(r));
  });

  test('rewrites open property-role cards: re-key, re-point, drop no-op flips, resolve empty cards', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    // the flip onto the copy of the current primary has nothing to do
    expect(card(db, 'card-flip')).toMatchObject({ status: 'resolved', resolution_source: 'system' });
    expect(proposalsOf(db, 'card-flip')).toEqual([]);
    // the occupancy change follows the copy to its keeper, under the new key
    expect(card(db, 'card-mixed').status).toBe('open');
    expect(proposalsOf(db, 'card-mixed')[0]).toMatchObject({ property_id: 'keep-b', address_key: addressKey(row(db, 'dup-b')) });
    // an unchanged address is re-keyed; a key that was already stale stays stale
    expect(proposalsOf(db, 'card-flip-c')[0]).toMatchObject({
      new_primary_property_id: 'rental-c', new_primary_address_key: addressKey(row(db, 'rental-c')), old_primary_address_key: 'stale-staged-key',
    });
    // closed cards are history
    expect(proposalsOf(db, 'card-closed')[0].property_id).toBe('dup-a');
  });

  test('a re-run changes nothing', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const snapshot = JSON.stringify([db.customer_properties, db.scheduled_services, db.triage_items]);
    await migration.up(fakeKnex(db));
    expect(JSON.stringify([db.customer_properties, db.scheduled_services, db.triage_items])).toBe(snapshot);
  });

  test('down() restores rows, keys and cards; references stay on the keeper', async () => {
    const db = seed();
    const before = JSON.parse(JSON.stringify(seed()));
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v-new', property_id: 'keep-a' });
    await migration.down(fakeKnex(db));
    expect(db.customer_properties).toEqual(before.customer_properties.map((r) => (
      ['dup-a', 'dup-b'].includes(r.id) ? { ...r, updated_at: 'NOW' } : r)));
    // references stay on the keeper (the same house), so nothing splits apart
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('keep-a');
    expect(db.estimates[0].property_id).toBe('keep-a');
    expect(db.scheduled_services.find((v) => v.id === 'v-new').property_id).toBe('keep-a');
    for (const id of ['card-flip', 'card-mixed', 'card-flip-c']) {
      expect(card(db, id).status).toBe('open');
      expect(JSON.parse(card(db, id).payload)).toEqual(JSON.parse(before.triage_items.find((c) => c.id === id).payload));
    }
    expect(db.system_settings).toEqual([]);
  });

  test('down() keys every row from its current address, edits and new rows included', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    row(db, 'other-b').address_line1 = '404 Test Creek Ct'; // edited after up()
    db.customer_properties.push(prop('new-c', 'c4', { address_line1: '520 Demo Ln', city: 'Venice', zip: '34285' }, { address_key: addressKey({ address_line1: '520 Demo Ln', zip: '34285' }) }));
    await migration.down(fakeKnex(db));
    for (const r of db.customer_properties) expect(r.address_key).toBe(legacyKey(r));
    expect(row(db, 'dup-a').active && row(db, 'dup-b').active).toBe(true);
  });

  test('re-anchors a grouped stop on the keeper with a free stop_seq; down() keeps it there with its members', async () => {
    const db = seed();
    db.service_visits = [
      { id: 'sv-dup', property_id: 'dup-a', stop_base_key: 'dup-a:2026-10-10', stop_seq: 0 },
      { id: 'sv-keep', property_id: 'keep-a', stop_base_key: 'keep-a:2026-10-10', stop_seq: 0 },
    ];
    db.scheduled_services.push({ id: 'v-grouped', property_id: 'dup-a', visit_id: 'sv-dup' });
    await migration.up(fakeKnex(db));
    expect(db.service_visits.find((v) => v.id === 'sv-dup')).toMatchObject({ property_id: 'keep-a', stop_base_key: 'keep-a:2026-10-10', stop_seq: 1 });
    expect(db.scheduled_services.find((v) => v.id === 'v-grouped').property_id).toBe('keep-a');
    db.scheduled_services.push({ id: 'v-joined', property_id: 'keep-a', visit_id: 'sv-dup' }); // joined since
    await migration.down(fakeKnex(db));
    // stops and their members stay together on the keeper; ungrouped visits go back
    expect(db.service_visits.find((v) => v.id === 'sv-dup')).toMatchObject({ property_id: 'keep-a', stop_base_key: 'keep-a:2026-10-10' });
    expect(db.scheduled_services.find((v) => v.id === 'v-grouped').property_id).toBe('keep-a');
    expect(db.scheduled_services.find((v) => v.id === 'v-joined').property_id).toBe('keep-a');
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('keep-a');
  });

  test('clears changing keys before assigning any, so an old key equal to another row\'s new key cannot collide', async () => {
    const db = seed();
    const roadAddr = { address_line1: '100 Main St', address_line2: 'Unit ROAD', city: 'Venice', zip: '34285' };
    const rdAddr = { address_line1: '100 Main St', address_line2: 'Unit RD', zip: '34285' };
    db.customer_properties.push(
      prop('road', 'c6', roadAddr, { is_primary: true, address_key: legacyKey(roadAddr) }),
      // its stored (old) key is exactly the new key of the ROAD row
      prop('rd', 'c6', rdAddr, { address_key: newKey(roadAddr) }),
    );
    await migration.up(fakeKnex(db));
    expect(row(db, 'road').address_key).toBe(newKey(roadAddr));
    expect(row(db, 'rd').address_key).toBe(newKey(rdAddr));
  });

  test('down() keeps current keys for rows the old format would merge, so rollback cannot collide', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const rd = { address_line1: '900 Demo St', address_line2: 'Unit RD', city: 'Venice', zip: '34285' };
    const road = { address_line1: '900 Demo St', address_line2: 'Unit ROAD', city: 'Venice', zip: '34285' };
    expect(legacyKey(rd)).toBe(legacyKey(road)); // the old format cannot tell them apart
    db.customer_properties.push(
      prop('unit-rd', 'c7', rd, { address_key: newKey(rd) }),
      prop('unit-road', 'c7', road, { address_key: newKey(road) }),
    );
    await migration.down(fakeKnex(db));
    expect(row(db, 'unit-rd')).toMatchObject({ active: true, address_key: newKey(rd) });
    expect(row(db, 'unit-road')).toMatchObject({ active: true, address_key: newKey(road) });
  });

  test('down() leaves a card staff resolved or edited after the migration as staff left it', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    Object.assign(card(db, 'card-mixed'), { status: 'resolved', resolution_source: 'human' });
    await migration.down(fakeKnex(db));
    expect(card(db, 'card-mixed')).toMatchObject({ status: 'resolved', resolution_source: 'human' });
    expect(card(db, 'card-flip').status).toBe('open'); // untouched since: restored
  });

  test('re-keys saved service-area measurements with their property, and down() restores them', async () => {
    const db = seed();
    const saved = { addressKey: legacyKey(C2), areas: { lawn: { sqft: 5000 } } };
    row(db, 'rental-c').service_area_measurements = JSON.stringify(saved);
    row(db, 'home-c').service_area_measurements = JSON.stringify({ addressKey: 'some-other-key', areas: {} });
    await migration.up(fakeKnex(db));
    expect(JSON.parse(row(db, 'rental-c').service_area_measurements)).toEqual({ ...saved, addressKey: addressKey(row(db, 'rental-c')) });
    expect(JSON.parse(row(db, 'home-c').service_area_measurements).addressKey).toBe('some-other-key'); // not ours to touch
    await migration.down(fakeKnex(db));
    expect(JSON.parse(row(db, 'rental-c').service_area_measurements)).toEqual(saved);
  });

  test('down() leaves references on the keeper when a copy cannot be reactivated', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    // the copy's house was re-entered since, under the old format's key
    db.customer_properties.push(prop('reentered-a', 'c1', A2));
    await migration.down(fakeKnex(db));
    expect(row(db, 'dup-a').active).toBe(false);
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('keep-a');
    expect(db.estimates[0].property_id).toBe('keep-a');
  });

  test('copies facts only the retired copy holds onto the keeper (keeper wins conflicts); down() leaves them there', async () => {
    const db = seed();
    const areas = { beds: { sqft: 900, source: 'measured' } };
    Object.assign(row(db, 'dup-a'), {
      bed_sqft: 900, property_type: 'single_family', latitude: 27.5, longitude: -82.4,
      service_area_measurements: JSON.stringify({ addressKey: legacyKey(A2), areas }),
    });
    Object.assign(row(db, 'keep-a'), { property_type: 'townhouse', latitude: null, longitude: null, bed_sqft: null, service_area_measurements: null });
    await migration.up(fakeKnex(db));
    const k = row(db, 'keep-a');
    expect(k).toMatchObject({ bed_sqft: 900, property_type: 'townhouse', latitude: 27.5, longitude: -82.4 });
    expect(JSON.parse(k.service_area_measurements)).toEqual({ addressKey: addressKey(k), areas });
    await migration.down(fakeKnex(db));
    expect(row(db, 'keep-a')).toMatchObject({ bed_sqft: 900, property_type: 'townhouse', latitude: 27.5, longitude: -82.4 });
    // the copied measurements follow the keeper back to its old-format key
    expect(JSON.parse(row(db, 'keep-a').service_area_measurements)).toEqual({ addressKey: legacyKey(row(db, 'keep-a')), areas });
  });

  test('leaves immutable field-credit history on the retired copy', async () => {
    const db = seed();
    db.field_credit_allocations = [{ id: 'f1', property_id: 'dup-a' }];
    await migration.up(fakeKnex(db));
    expect(db.field_credit_allocations[0].property_id).toBe('dup-a');
    expect(db.__log[1]).not.toContain('field_credit_allocations');
  });

  test('the frozen new key matches the live addressKey; the legacy key is the pre-2026-10-02 format', () => {
    const fixtures = [
      A1, A2, B1, B2, C1,
      { address_line1: '100 Main St Apt 4', address_line2: 'Building A', zip: '34285' },
      { address_line1: '100 Main St Apt 4 Building A', zip: '34285' },
      { address_line1: '100 Main St#4.', zip: '34285' },
      { address_line1: '100 Unit Rd', city: 'Venice' },
      { address_line1: '700 Demo Gln Unit PT', zip: '34219' },
      { address_line1: '700 Demo Gln Unit AB', zip: '34219' },
      { address_line1: '700 Demo Gln Unit PT Building A', zip: '34219' },
      { address_line1: '700 Demo Pt', address_line2: 'Unit PT', zip: '34219-1234' },
      { address_line1: '', city: 'Venice' },
    ];
    for (const f of fixtures) expect(newKey(f)).toBe(addressKey(f));
    expect(legacyKey({ address_line1: '400 Test Creek Ct', address_line2: 'Apt 4', city: 'Duette', zip: '34219-1234' }))
      .toBe('400testcreekcourt4duette34219');
  });
});
