/**
 * 20261001200000 — recompute customer_properties.address_key for the
 * 2026-10-01 addressKey, folding the active rows that now share a key.
 * Pins: one house spelled two ways folds into the primary with its
 * references, a unique-index refusal leaves that reference behind, distinct
 * houses and inactive rows are untouched, every key is recomputed, and
 * down() reverses exactly what up() did.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const { addressKey } = require('../services/customer-properties');
const migration = require('../models/migrations/20261001200000_recompute_property_address_keys');
const reconcile = require('../models/migrations/20261001200100_reconcile_property_address_keys_locked');
const undoStale = require('../models/migrations/20261001200200_undo_stale_property_folds');

function fakeKnex(db) {
  const rowsOf = (t) => (db[t] = db[t] || []);
  const knex = (table) => {
    const preds = [];
    const match = (r) => preds.every((p) => p(r));
    const q = {
      where(obj) { preds.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return q; },
      whereIn(col, vals) { preds.push((r) => vals.includes(r[col])); return q; },
      async select() { return rowsOf(table).filter(match).map((r) => ({ ...r })); },
      async first() { const h = rowsOf(table).find(match); return h ? { ...h } : undefined; },
      async update(patch) {
        const hits = rowsOf(table).filter(match);
        for (const h of hits) {
          const next = { ...h, ...patch };
          if (table === 'customer_properties' && next.active && next.address_key) {
            // customer_properties_customer_address_uniq (customer_id, address_key) WHERE active
            if (rowsOf(table).some((o) => o !== h && o.active && o.customer_id === next.customer_id && o.address_key === next.address_key)) {
              throw Object.assign(new Error('duplicate key'), { code: '23505' });
            }
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
    hasColumn: async (t, c) => c === 'property_id' && t in db,
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql) => { (db.__raw = db.__raw || []).push(sql); };
  knex.transaction = async (fn) => fn(knex);
  return knex;
}

// Fictional addresses. Old-format keys (street + unit + city + ZIP) so the
// pairs coexist as they did before the migration.
const legacyKey = (a) => `legacy:${a.address_line1}|${a.city}|${a.zip}`;
const prop = (id, customer_id, addr, extra = {}) => ({
  id, customer_id, active: true, is_primary: false, created_at: '2026-09-01T00:00:00Z',
  address_line2: null, ...addr, address_key: legacyKey(addr), ...extra,
});

function seed() {
  return {
    customer_properties: [
      prop('keep-a', 'c1', { address_line1: '200 Example Gln', city: 'Parrish', zip: '34219' }, { is_primary: true }),
      prop('dup-a', 'c1', { address_line1: '200 Example Glen', city: 'Parrish', zip: '34219' }, { created_at: '2026-09-01T00:00:01Z' }),
      prop('keep-b', 'c2', { address_line1: '400 Test Creek Ct', city: 'Duette', zip: '34219' }, { is_primary: true }),
      prop('dup-b', 'c2', { address_line1: '400 Test Creek Court', city: 'Parrish', zip: '34219' }),
      prop('other-b', 'c2', { address_line1: '402 Test Creek Ct', city: 'Parrish', zip: '34219' }),
      prop('old-b', 'c2', { address_line1: '400 Test Creek Ct', city: 'Parrish', zip: '34219' }, { active: false }),
    ],
    scheduled_services: [
      { id: 'v1', property_id: 'dup-a' },
      { id: 'v2', property_id: 'other-b' },
    ],
    estimates: [{ id: 'e1', property_id: 'dup-a' }],
    property_notification_prefs: [
      { id: 'n-keep', property_id: 'keep-a' },
      { id: 'n-dup', property_id: 'dup-a' },
    ],
    system_settings: [],
  };
}
const row = (db, id) => db.customer_properties.find((r) => r.id === id);

describe('20261001200000 recompute property address keys', () => {
  test('up() folds one house spelled two ways into the primary, moving its references', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(row(db, 'dup-a')).toMatchObject({ active: false, is_primary: false });
    expect(row(db, 'dup-b')).toMatchObject({ active: false, is_primary: false });
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('keep-a');
    expect(db.estimates[0].property_id).toBe('keep-a');
    // the keeper already has prefs (unique on property_id) → the copy's stay behind
    expect(db.property_notification_prefs.find((p) => p.id === 'n-dup').property_id).toBe('dup-a');
    // a different house and an already-inactive row are not folded
    expect(row(db, 'other-b').active).toBe(true);
    expect(db.scheduled_services.find((v) => v.id === 'v2').property_id).toBe('other-b');
    expect(row(db, 'keep-a').active && row(db, 'keep-b').active).toBe(true);
  });

  test('up() stores the live key on every row, retired ones included', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    for (const r of db.customer_properties) expect(r.address_key).toBe(addressKey(r));
    expect(row(db, 'keep-a').address_key).toBe(row(db, 'dup-a').address_key);
  });

  test('up() is idempotent', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const snapshot = JSON.stringify(db.customer_properties);
    await migration.up(fakeKnex(db));
    expect(JSON.stringify(db.customer_properties)).toBe(snapshot);
  });

  test('down() restores the old keys, reactivates the copies and moves back only what up() moved', async () => {
    const db = seed();
    const before = JSON.parse(JSON.stringify(seed()));
    await migration.up(fakeKnex(db));
    db.scheduled_services.push({ id: 'v-new', property_id: 'keep-a' }); // booked after the migration
    await migration.down(fakeKnex(db));
    expect(db.customer_properties).toEqual(before.customer_properties.map((r) => (
      ['dup-a', 'dup-b'].includes(r.id) ? { ...r, updated_at: 'NOW' } : r)));
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('dup-a');
    expect(db.estimates[0].property_id).toBe('dup-a');
    expect(db.scheduled_services.find((v) => v.id === 'v-new').property_id).toBe('keep-a');
    expect(db.system_settings).toEqual([]);
  });
});

describe('20261001200100 locked reconcile', () => {
  test('locks customer_properties before it reads, and is a no-op after an undisturbed recompute', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const snapshot = JSON.stringify(db.customer_properties);
    await reconcile.up(fakeKnex(db));
    expect(db.__raw).toEqual(['LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE']);
    expect(JSON.stringify(db.customer_properties)).toBe(snapshot);
  });

  test('repairs a row written while the recompute ran: stale key rewritten, new same-house copy folded', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    // an address edit that landed mid-run with an old-format key ...
    Object.assign(row(db, 'other-b'), { address_line1: '402 Test Creek Court', address_key: 'stale' });
    // ... and a call-pipeline copy of keeper-a inserted with an old-format key
    db.customer_properties.push(prop('late-a', 'c1', { address_line1: '200 Example Glen.', city: 'Parrish', zip: '34219' }));
    db.scheduled_services.push({ id: 'v-late', property_id: 'late-a' });
    await reconcile.up(fakeKnex(db));
    expect(row(db, 'other-b').address_key).toBe(addressKey(row(db, 'other-b')));
    expect(row(db, 'late-a')).toMatchObject({ active: false, address_key: row(db, 'keep-a').address_key });
    expect(db.scheduled_services.find((v) => v.id === 'v-late').property_id).toBe('keep-a');

    await reconcile.down(fakeKnex(db));
    expect(row(db, 'late-a')).toMatchObject({ active: true, address_key: legacyKey({ address_line1: '200 Example Glen.', city: 'Parrish', zip: '34219' }) });
    expect(row(db, 'other-b').address_key).toBe('stale');
    expect(db.scheduled_services.find((v) => v.id === 'v-late').property_id).toBe('late-a');
    expect(db.system_settings.find((r) => r.key === reconcile.STATE_KEY)).toBeUndefined();
  });
});

describe('20261001200200 undo stale property folds', () => {
  test('after recompute + reconcile, undoes a fold whose copy was edited into a different house mid-run', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    expect(row(db, 'dup-a').active).toBe(false);
    // the office corrected the copy's address while the first pass ran
    row(db, 'dup-a').address_line1 = '210 Example Glen';
    await reconcile.up(fakeKnex(db));
    expect(row(db, 'dup-a').active).toBe(false); // the reconcile groups active rows only
    db.__raw = [];
    await undoStale.up(fakeKnex(db));
    expect(db.__raw[0]).toBe('LOCK TABLE customer_properties IN SHARE ROW EXCLUSIVE MODE');
    expect(row(db, 'dup-a')).toMatchObject({ active: true, address_key: addressKey(row(db, 'dup-a')) });
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('dup-a');
    expect(db.estimates[0].property_id).toBe('dup-a');
    expect(row(db, 'dup-b').active).toBe(false); // a fold the data still supports holds

    await undoStale.down(fakeKnex(db));
    expect(row(db, 'dup-a').active).toBe(false);
    expect(db.scheduled_services.find((v) => v.id === 'v1').property_id).toBe('keep-a');
    expect(db.system_settings.find((r) => r.key === undoStale.STATE_KEY)).toBeUndefined();
  });

  test('changes nothing after an undisturbed recompute', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    await reconcile.up(fakeKnex(db));
    const snapshot = JSON.stringify([db.customer_properties, db.scheduled_services, db.estimates]);
    await undoStale.up(fakeKnex(db));
    expect(JSON.stringify([db.customer_properties, db.scheduled_services, db.estimates])).toBe(snapshot);
  });

  test('leaves a copy retired when its new address matches another active row', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    row(db, 'dup-b').address_line1 = '402 Test Creek Court'; // now other-b's house
    await reconcile.up(fakeKnex(db));
    await undoStale.up(fakeKnex(db));
    expect(row(db, 'dup-b').active).toBe(false);
    expect(row(db, 'other-b').active).toBe(true);
  });
});
