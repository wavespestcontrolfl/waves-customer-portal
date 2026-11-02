/**
 * 20261102130000 — address key: street directionals and more suffix forms.
 * Fake-knex harness (no database), like the 20261002090000 suite, so it runs
 * everywhere. Pins: the live addressKey / streetKey / scope key expand a
 * directional and the new suffix forms in STREET words only; the frozen new
 * key equals the live addressKey and the frozen old key equals the
 * 2026-10-02 format; every table is locked before the first read; a
 * directional / suffix duplicate folds into the primary, else the oldest
 * row; references move (a reference the keeper already holds under a unique
 * index stays on the copy); field credits and portal chat receipts stay;
 * open role cards, saved measurements, home line stamps and permit keys are
 * re-keyed; down() restores them.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const {
  addressKey, streetKey, canonicalizeAddress, canonicalizeScopeAddress,
} = require('../services/customer-properties');
const migration = require('../models/migrations/20261102130000_address_key_directionals');
const previous = require('../models/migrations/20261002090000_one_house_one_address_key');

const { oldKey, newKey } = migration;
const Z = '34219';
const key = (address_line1, extra = {}) => addressKey({ address_line1, zip: Z, ...extra });

describe('address key: street directionals and suffix short forms', () => {
  const same = [
    ['4100 61st Ave E', '4100 61st Avenue East'],
    ['10 Demo St E', '10 Demo Street East'],
    ['10 Demo Pl E', '10 Demo Place East'],
    ['10 Demo Ln E', '10 Demo Lane East'],
    ['10 Demo Ave Cir W', '10 Demo Avenue Circle West'],
    ['12 Sample Bay Lp', '12 Sample Bay Loop'],
    ['5 Test Grv Wy', '5 Test Grove Way'],
    ['7 Demo Dr NE', '7 Demo Drive Northeast'],
    ['7 Demo Dr nw.', '7 Demo Drive NorthWest'],
    ['7 Demo Dr SE', '7 Demo Drive Southeast'],
    ['7 Demo Dr S', '7 Demo Drive South'],
    ['7 Demo Dr SW', '7 Demo Drive Southwest'],
    ['7 N Demo Dr', '7 North Demo Drive'],
    ['9 Foo Cres', '9 Foo Crescent'],
    ['9 Foo Hbr', '9 Foo Harbor'],
    ['9 Foo Lk', '9 Foo Lake'],
    ['9 Foo Vlg', '9 Foo Village'],
    ['9 Foo Vly', '9 Foo Valley'],
    ['9 Foo Spgs', '9 Foo Springs'],
    ['9 Foo Brk', '9 Foo Brook'],
    ['9 Foo Blf', '9 Foo Bluff'],
    ['9 Foo Ests', '9 Foo Estates'],
    ['9 Foo Pnes', '9 Foo Pines'],
    ['9 Foo Rnch', '9 Foo Ranch'],
    ['9 Foo Shrs', '9 Foo Shores'],
    ['9 Foo Knl', '9 Foo Knoll'],
    ['9 Foo Mnr', '9 Foo Manor'],
    ['9 Foo Orch', '9 Foo Orchard'],
    ['9 Foo Frst', '9 Foo Forest'],
    ['9 Foo Bch', '9 Foo Beach'],
    ['9 Foo Gdns', '9 Foo Gardens'],
    ['9 Foo Grn', '9 Foo Green'],
    ['9 Foo Hls', '9 Foo Hills'],
    ['9 Foo Cmn', '9 Foo Common'],
    ['9 Foo Crst', '9 Foo Crest'],
    ['9 Foo Lks', '9 Foo Lakes'],
    ['9 Foo Shr', '9 Foo Shore'],
    ['9 Foo Spg', '9 Foo Spring'],
    ['9 Foo Hl', '9 Foo Hill'],
    ['9 Foo Gdn', '9 Foo Garden'],
  ];
  test.each(same)('%s keys like %s', (a, b) => {
    expect(key(a)).toBe(key(b));
    expect(streetKey(a)).toBe(streetKey(b));
  });

  test('nothing is ever stripped: different suffixes, directionals and numbers stay distinct', () => {
    expect(key('100 Main St')).not.toBe(key('100 Main Ave'));
    expect(key('100 Main St E')).not.toBe(key('100 Main St'));
    expect(key('100 Main St E')).not.toBe(key('100 Main St W'));
    expect(key('100 Main St N')).not.toBe(key('100 Main St S'));
    expect(key('100 Main St')).not.toBe(key('102 Main St'));
    expect(key('12 Demo Lp')).not.toBe(key('12 Demo Ln'));
    expect(key('9 Foo Lk')).not.toBe(key('9 Foo Hl'));
  });

  test('a unit id is data, not a direction: Apt E stays exact', () => {
    expect(key('100 Main St Apt E')).not.toBe(key('100 Main St Apt East'));
    expect(key('100 Main St', { address_line2: 'Apt E' })).not.toBe(key('100 Main St', { address_line2: 'Apt East' }));
    expect(key('100 Main St', { address_line2: 'Unit W' })).not.toBe(key('100 Main St', { address_line2: 'Unit West' }));
    // The street still expands next to a unit, and inline and split units agree.
    expect(key('100 Main St E Apt E')).toBe(key('100 Main Street East', { address_line2: 'Apt E' }));
    expect(key('100 Main St E', { address_line2: 'Apt E' })).not.toBe(key('100 Main St E', { address_line2: 'Apt 4' }));
  });

  test('the scope key (estimate-property-linkage) and the address key agree on the street', () => {
    for (const [a, b] of same) {
      expect(canonicalizeScopeAddress(a)).toBe(canonicalizeScopeAddress(b));
      expect(canonicalizeScopeAddress(a).replace(/[^a-z0-9]/g, '')).toBe(streetKey(a));
    }
    // canonicalizeAddress is also run over a unit line, so it expands suffixes only.
    expect(canonicalizeAddress('Apt E')).toBe('apt e');
    expect(canonicalizeAddress('100 Main Lp')).toBe('100 main loop');
  });
});

describe('20261102130000 frozen key copies', () => {
  const fixtures = [
    { address_line1: '4100 61st Ave E', city: 'Parrish', zip: '34219' },
    { address_line1: '4100 61st Avenue East', city: 'Parrish', zip: '34219-1234' },
    { address_line1: '10 Demo Ave Cir W', zip: Z },
    { address_line1: '12 Sample Bay Lp', city: 'Parrish' },
    { address_line1: '5 Test Grv Wy', zip: Z },
    { address_line1: '100 Main St Apt E', zip: Z },
    { address_line1: '100 Main St Apt East', zip: Z },
    { address_line1: '100 Main St E', address_line2: 'Apt E', zip: Z },
    { address_line1: '100 Main St#E', zip: Z },
    { address_line1: '100 Main St Apt 4 Building A', zip: Z },
    { address_line1: '700 Demo Gln Unit PT', zip: Z },
    { address_line1: '700 Demo Pt', address_line2: 'Unit PT', zip: '34219-1234' },
    { address_line1: '9 Foo Hbr Dr NE', zip: Z },
    { address_line1: '', city: 'Venice' },
  ];
  test('the new key is the live addressKey', () => {
    for (const f of fixtures) expect(newKey(f)).toBe(addressKey(f));
  });
  test('the old key is the 2026-10-02 format, so up() reads stored keys the way they were written', () => {
    for (const f of fixtures) expect(oldKey(f)).toBe(previous.newKey(f));
    expect(oldKey({ address_line1: '10 Demo Ave E', zip: Z })).toBe('10demoavenuee34219');
    expect(newKey({ address_line1: '10 Demo Ave E', zip: Z })).toBe('10demoavenueeast34219');
  });
  test('the audit-free state key and the migration name fit the 96-character action limit', () => {
    expect(migration.STATE_KEY.length).toBeLessThanOrEqual(96);
    expect('20261102130000_address_key_directionals'.length).toBeLessThanOrEqual(45);
  });
});

// ── Fake knex ───────────────────────────────────────────────────────────
const UNIQUE = {
  property_notification_prefs: ['property_id'],
  lawn_trouble_areas: ['property_id', 'place', 'type'],
};

function fakeKnex(db) {
  const log = (db.__log = db.__log || []);
  const rowsOf = (t) => (db[t] = db[t] || []);
  const knex = (table) => {
    const preds = [];
    const match = (r) => preds.every((p) => p(r));
    const q = {
      where(obj) { preds.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return q; },
      whereIn(col, vals) { preds.push((r) => vals.includes(r[col])); return q; },
      whereNotNull(col) { preds.push((r) => r[col] != null); return q; },
      max(expr) {
        const [col, , alias] = expr.split(' ');
        return { first: async () => { const vals = rowsOf(table).filter(match).map((r) => r[col]); return { [alias]: vals.length ? Math.max(...vals) : null }; } };
      },
      async select() { log.push(`select ${table}`); return rowsOf(table).filter(match).map((r) => ({ ...r })); },
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
          const cols = UNIQUE[table];
          if (cols && rowsOf(table).some((o) => o !== h && cols.every((c) => o[c] === next[c]))) {
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
    hasColumn: async (t, c) => {
      if (!(t in db)) return false;
      if (t === 'customer_properties') return true;
      if (t === 'customers') return c === 'home_line_address_key';
      if (t === 'pool_permit_records') return c === 'address_key';
      return c === 'property_id';
    },
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql) => { log.push(sql); };
  knex.transaction = async (fn) => fn(knex);
  return knex;
}

// Fictional addresses, stored with the keys the code wrote before this migration.
const prop = (id, customer_id, addr, extra = {}) => ({
  id, customer_id, active: true, is_primary: false, created_at: '2026-09-01T00:00:00Z',
  address_line2: null, ...addr, address_key: oldKey({ address_line2: null, ...addr }), ...extra,
});
const A1 = { address_line1: '4100 61st Ave E', city: 'Parrish', zip: Z };
const A2 = { address_line1: '4100 61st Avenue East', city: 'Parrish', zip: Z };
const B1 = { address_line1: '5 Demo Lp', city: 'Parrish', zip: Z };
const B2 = { address_line1: '5 Demo Loop', city: 'Parrish', zip: Z };
const C1 = { address_line1: '30 Test Grv Wy', city: 'Parrish', zip: Z };
const C2 = { address_line1: '30 Test Grove Way', city: 'Parrish', zip: Z };

function seed() {
  return {
    customer_properties: [
      prop('keep-a', 'c1', A1, { is_primary: true }),
      prop('dup-a', 'c1', A2, { created_at: '2026-09-01T00:00:01Z' }),
      // neither is primary: the oldest wins
      prop('old-b', 'c2', B1, { created_at: '2026-08-01T00:00:00Z' }),
      prop('new-b', 'c2', B2, { created_at: '2026-09-15T00:00:00Z' }),
      prop('keep-c', 'c4', C1, { is_primary: true }),
      prop('dup-c', 'c4', C2),
      // different houses and different units stay apart
      prop('main-st', 'c3', { address_line1: '10 Main St', city: 'Venice', zip: '34285' }, { is_primary: true }),
      prop('main-ave', 'c3', { address_line1: '10 Main Ave', city: 'Venice', zip: '34285' }),
      prop('apt-e', 'c3', { address_line1: '12 Main St Apt E', city: 'Venice', zip: '34285' }),
      prop('apt-east', 'c3', { address_line1: '12 Main St Apt East', city: 'Venice', zip: '34285' }),
      prop('dir-e', 'c5', { address_line1: '40 Demo Dr E', city: 'Venice', zip: '34285' }, { is_primary: true }),
      prop('dir-w', 'c5', { address_line1: '40 Demo Dr W', city: 'Venice', zip: '34285' }),
      prop('retired', 'c1', A2, { active: false }),
    ],
    scheduled_services: [
      { id: 'v1', property_id: 'dup-a' },
      { id: 'v2', property_id: 'new-b' },
      { id: 'v3', property_id: 'old-b' },
    ],
    estimates: [{ id: 'e1', property_id: 'dup-a' }],
    customer_access_codes: [{ id: 'ac1', property_id: 'dup-a' }],
    property_application_history: [{ id: 'pah1', property_id: 'dup-a' }, { id: 'pah2', property_id: 'dup-c' }],
    misting_calibrations: [{ id: 'mc1', property_id: 'new-b' }],
    misting_refills: [{ id: 'mr1', property_id: 'new-b' }],
    property_notification_prefs: [{ id: 'n-keep', property_id: 'keep-a' }, { id: 'n-dup', property_id: 'dup-a' }],
    lawn_trouble_areas: [
      { id: 't-keep', property_id: 'keep-c', place: 'front', type: 'dry' },
      { id: 't-dup-same', property_id: 'dup-c', place: 'front', type: 'dry' },
      { id: 't-dup-new', property_id: 'dup-c', place: 'back', type: 'dry' },
    ],
    field_credit_allocations: [{ id: 'f1', property_id: 'dup-a' }],
    portal_chat_requests: [{ id: 'p1', property_id: 'dup-a' }],
    customers: [
      { id: 'cu1', address_line1: '4100 61st Ave E', address_line2: null, city: 'Parrish', zip: Z, home_line_address_key: oldKey(A1), home_line_source: 'staff' },
      { id: 'cu2', address_line1: '9 Plain St', address_line2: null, city: 'Parrish', zip: Z, home_line_address_key: oldKey({ address_line1: '9 Plain St', city: 'Parrish', zip: Z }) },
      { id: 'cu3', address_line1: '2 Demo Dr S', address_line2: null, city: 'Parrish', zip: Z, home_line_address_key: 'stale-key' },
      { id: 'cu4', address_line1: '3 Demo Dr S', address_line2: null, city: 'Parrish', zip: Z, home_line_address_key: null },
    ],
    pool_permit_records: [
      { id: 'pp1', address_line1: '30 Test Grv Wy', city: 'Parrish', zip: Z, address_key: oldKey(C1) },
      { id: 'pp2', address_line1: '31 Plain St', city: 'Parrish', zip: Z, address_key: oldKey({ address_line1: '31 Plain St', city: 'Parrish', zip: Z }) },
      { id: 'pp3', address_line1: '32 Test Grv Wy', city: 'Parrish', zip: Z, address_key: null },
    ],
    triage_items: [
      { id: 'card-flip', reason_code: 'property_role_confirm', status: 'open', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'primary_flip', new_primary_property_id: 'dup-a', new_primary_address_key: oldKey(A2), old_primary_property_id: 'keep-a', old_primary_address_key: oldKey(A1) },
      ] }) },
      { id: 'card-occ', reason_code: 'property_role_confirm', status: 'open', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'occupancy_change', property_id: 'new-b', address_key: oldKey(B2), proposed_occupancy: 'owner_occupied' },
        { kind: 'occupancy_change', property_id: 'dir-w', address_key: 'stale-staged-key' },
      ] }) },
      { id: 'card-closed', reason_code: 'property_role_confirm', status: 'resolved', payload: JSON.stringify({ property_role_proposals: [
        { kind: 'occupancy_change', property_id: 'dup-a', address_key: oldKey(A2) },
      ] }) },
    ],
    system_settings: [],
  };
}
const row = (db, id) => db.customer_properties.find((r) => r.id === id);
const card = (db, id) => db.triage_items.find((r) => r.id === id);
const proposalsOf = (db, id) => JSON.parse(card(db, id).payload).property_role_proposals;
const refOf = (db, table, id) => db[table].find((r) => r.id === id).property_id;

describe('20261102130000 address key directionals', () => {
  test('locks every table it touches before its first read; the two history-only tables are not in the lock', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(db.__log[0]).toBe("SET LOCAL lock_timeout = '20s'");
    expect(db.__log[1]).toBe('LOCK TABLE customer_properties, scheduled_services, estimates, property_notification_prefs, customer_access_codes, lawn_trouble_areas, misting_calibrations, misting_refills, property_application_history, triage_items IN SHARE ROW EXCLUSIVE MODE');
    expect(db.__log[2]).toBe('select customer_properties');
    expect(db.__log[1]).not.toMatch(/field_credit_allocations|portal_chat_requests/);
    expect(migration.REFERENCE_TABLES).toEqual(expect.arrayContaining([
      'customer_access_codes', 'lawn_trouble_areas', 'misting_calibrations', 'misting_refills', 'property_application_history',
    ]));
  });

  test('folds the directional / suffix duplicate into the primary and moves its references', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(row(db, 'dup-a')).toMatchObject({ active: false, is_primary: false });
    expect(row(db, 'keep-a')).toMatchObject({ active: true, is_primary: true });
    expect(refOf(db, 'scheduled_services', 'v1')).toBe('keep-a');
    expect(refOf(db, 'estimates', 'e1')).toBe('keep-a');
    expect(refOf(db, 'customer_access_codes', 'ac1')).toBe('keep-a');
    expect(refOf(db, 'property_application_history', 'pah1')).toBe('keep-a');
    // the keeper already has prefs (unique on property_id): the copy's stay as history
    expect(refOf(db, 'property_notification_prefs', 'n-dup')).toBe('dup-a');
    expect(refOf(db, 'property_notification_prefs', 'n-keep')).toBe('keep-a');
  });

  test('when neither row is primary the oldest wins, and its key is the new key', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(row(db, 'old-b')).toMatchObject({ active: true, is_primary: false });
    expect(row(db, 'new-b')).toMatchObject({ active: false, is_primary: false });
    expect(refOf(db, 'scheduled_services', 'v2')).toBe('old-b');
    expect(refOf(db, 'misting_calibrations', 'mc1')).toBe('old-b');
    expect(refOf(db, 'misting_refills', 'mr1')).toBe('old-b');
    expect(refOf(db, 'scheduled_services', 'v3')).toBe('old-b');
  });

  test('a reference the keeper already holds under a unique index stays on the copy; the rest moves', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(refOf(db, 'lawn_trouble_areas', 't-dup-same')).toBe('dup-c'); // keeper has front/dry
    expect(refOf(db, 'lawn_trouble_areas', 't-dup-new')).toBe('keep-c');
    expect(refOf(db, 'property_application_history', 'pah2')).toBe('keep-c');
    expect(row(db, 'dup-c').active).toBe(false);
  });

  test('field credits and portal chat receipts are left on the retired copy', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(refOf(db, 'field_credit_allocations', 'f1')).toBe('dup-a');
    expect(refOf(db, 'portal_chat_requests', 'p1')).toBe('dup-a');
  });

  test('different suffixes, different directionals and different unit ids stay separate properties', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    for (const id of ['main-st', 'main-ave', 'apt-e', 'apt-east', 'dir-e', 'dir-w']) expect(row(db, id).active).toBe(true);
  });

  test('every stored key becomes the live key, retired rows included', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    for (const r of db.customer_properties) expect(r.address_key).toBe(addressKey(r));
    expect(row(db, 'keep-a').address_key).toBe(row(db, 'dup-a').address_key);
  });

  test('re-keys open role cards, re-points copies at their keeper, resolves an empty card', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(card(db, 'card-flip')).toMatchObject({ status: 'resolved', resolution_source: 'system' });
    expect(proposalsOf(db, 'card-flip')).toEqual([]);
    expect(card(db, 'card-occ').status).toBe('open');
    const [moved, stale] = proposalsOf(db, 'card-occ');
    expect(moved).toMatchObject({ property_id: 'old-b', address_key: addressKey(row(db, 'new-b')) });
    // a key that was already stale stays stale
    expect(stale).toMatchObject({ property_id: 'dir-w', address_key: 'stale-staged-key' });
    expect(proposalsOf(db, 'card-closed')[0].property_id).toBe('dup-a');
  });

  test('re-keys saved measurements with their property; the keeper copies the copy\'s reviewed areas', async () => {
    const db = seed();
    const areas = { beds: { sqft: 900, source: 'measured' } };
    Object.assign(row(db, 'dir-e'), { service_area_measurements: JSON.stringify({ addressKey: oldKey(row(db, 'dir-e')), areas }) });
    Object.assign(row(db, 'dir-w'), { service_area_measurements: JSON.stringify({ addressKey: 'some-other-key', areas }) });
    Object.assign(row(db, 'dup-c'), { bed_sqft: 900, service_area_measurements: JSON.stringify({ addressKey: oldKey(C2), areas }) });
    Object.assign(row(db, 'keep-c'), { bed_sqft: null, service_area_measurements: null });
    await migration.up(fakeKnex(db));
    expect(JSON.parse(row(db, 'dir-e').service_area_measurements).addressKey).toBe(addressKey(row(db, 'dir-e')));
    expect(JSON.parse(row(db, 'dir-w').service_area_measurements).addressKey).toBe('some-other-key');
    expect(JSON.parse(row(db, 'keep-c').service_area_measurements)).toEqual({ addressKey: addressKey(row(db, 'keep-c')), areas });
  });

  test('moves a home line stamp and a permit key only while each still equals the old key of its own address', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const cu = (id) => db.customers.find((c) => c.id === id);
    expect(cu('cu1').home_line_address_key).toBe(addressKey(cu('cu1')));
    expect(cu('cu1').home_line_source).toBe('staff');
    expect(cu('cu2').home_line_address_key).toBe(oldKey({ address_line1: '9 Plain St', city: 'Parrish', zip: Z })); // unchanged format
    expect(cu('cu3').home_line_address_key).toBe('stale-key');
    expect(cu('cu4').home_line_address_key).toBeNull();
    const pp = (id) => db.pool_permit_records.find((r) => r.id === id).address_key;
    expect(pp('pp1')).toBe(addressKey(C1));
    expect(pp('pp2')).toBe(oldKey({ address_line1: '31 Plain St', city: 'Parrish', zip: Z }));
    expect(pp('pp3')).toBeNull();
    expect(JSON.parse(db.system_settings[0].value).homeLines).toEqual(['cu1']);
  });

  test('a re-run changes nothing', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const snapshot = JSON.stringify([db.customer_properties, db.scheduled_services, db.triage_items, db.customers, db.pool_permit_records]);
    await migration.up(fakeKnex(db));
    expect(JSON.stringify([db.customer_properties, db.scheduled_services, db.triage_items, db.customers, db.pool_permit_records])).toBe(snapshot);
  });

  test('down() restores rows, keys, cards, home line stamps and permit keys; references stay on the keeper', async () => {
    const db = seed();
    const before = JSON.parse(JSON.stringify(seed()));
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(db.customer_properties.map((r) => ({ ...r, updated_at: undefined })))
      .toEqual(before.customer_properties.map((r) => ({ ...r, updated_at: undefined })));
    expect(refOf(db, 'scheduled_services', 'v1')).toBe('keep-a');
    expect(refOf(db, 'estimates', 'e1')).toBe('keep-a');
    for (const id of ['card-flip', 'card-occ']) {
      expect(card(db, id).status).toBe('open');
      expect(JSON.parse(card(db, id).payload)).toEqual(JSON.parse(before.triage_items.find((c) => c.id === id).payload));
    }
    expect(db.customers).toEqual(before.customers);
    expect(db.pool_permit_records).toEqual(before.pool_permit_records);
    expect(db.system_settings).toEqual([]);
  });

  test('down() leaves a card staff resolved after the migration as staff left it', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    Object.assign(card(db, 'card-occ'), { status: 'resolved', resolution_source: 'human' });
    await migration.down(fakeKnex(db));
    expect(card(db, 'card-occ')).toMatchObject({ status: 'resolved', resolution_source: 'human' });
    expect(card(db, 'card-flip').status).toBe('open');
  });

  test('down() keeps a stamp staff changed after the migration', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    db.customers.find((c) => c.id === 'cu1').home_line_address_key = 'staff-set-later';
    await migration.down(fakeKnex(db));
    expect(db.customers.find((c) => c.id === 'cu1').home_line_address_key).toBe('staff-set-later');
  });
});
