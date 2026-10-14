/**
 * 20261010150000: rolling back the area add-on discount rules keeps a rule an operator edited. The frozen seed migration's
 * down() deletes by service key, its note and exclude_from_pct_discount true, which the Pricing Logic panel's edits of the
 * tier qualifier, the cap, the credit and the credit tier do not change. This later migration's down() runs first and gives
 * an edited rule a different note, so the older down() leaves it.
 */
const guard = require('../models/migrations/20261010150000_area_addon_discount_rules_rollback_guard');
const seed = require('../models/migrations/20261010100000_area_addon_discount_rules');

function fakeKnex(db) {
  const knex = (table) => {
    let conds = [];
    const match = (row) => conds.every((c) => (c.list ? c.list.includes(row[c.col]) : Object.entries(c.obj).every(([k, v]) => row[k] === v)));
    const rows = () => db[table] || [];
    const q = {
      where(obj) { conds = [...conds, { obj }]; return q; },
      whereIn(col, list) { conds = [...conds, { col, list }]; return q; },
      first: async () => { const hit = rows().find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { rows().filter(match).forEach((row) => Object.assign(row, patch)); },
      del: async () => { db[table] = rows().filter((row) => !match(row)); },
      then: (resolve, reject) => Promise.resolve(rows().filter(match).map((row) => ({ ...row }))).then(resolve, reject),
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}

// The rows 20261010100000 writes, as Postgres returns them.
const seeded = () => ({
  service_discount_rules: [
    ...seed.SERVICE_KEYS.map((key) => ({
      service_key: key, tier_qualifier: false, max_discount_pct: null, flat_credit: null, flat_credit_min_tier: null, exclude_from_pct_discount: true, notes: seed.NOTE,
    })),
    // A rule that is not one of the add-ons' is never looked at.
    { service_key: 'rodent_bait', tier_qualifier: true, max_discount_pct: '0.1500', flat_credit: null, flat_credit_min_tier: null, exclude_from_pct_discount: false, notes: 'Rodent policy' },
  ],
});
const rollBack = async (db) => { const knex = fakeKnex(db); await guard.down(knex); await seed.down(knex); };
const KEY = 'area_addon_fire_ant_yard';
const keysLeft = (db) => db.service_discount_rules.map((r) => r.service_key).filter((k) => k.startsWith('area_addon_'));

describe('area add-on discount rules rollback guard', () => {
  test('up changes nothing, and an unedited seed rolls back completely', async () => {
    const db = seeded();
    await guard.up(fakeKnex(db));
    expect(db.service_discount_rules.filter((r) => r.notes === seed.NOTE)).toHaveLength(seed.SERVICE_KEYS.length);
    await rollBack(db);
    expect(keysLeft(db)).toEqual([]);
    expect(db.service_discount_rules.map((r) => r.service_key)).toEqual(['rodent_bait']);
  });

  test.each([
    ['tier qualifier', { tier_qualifier: true }],
    ['cap', { max_discount_pct: '0.1000' }],
    ['a cap of zero', { max_discount_pct: 0 }],
    ['credit', { flat_credit: '25.00' }],
    ['credit tier', { flat_credit_min_tier: 'gold' }],
    ['exclusion', { exclude_from_pct_discount: false }],
    ['note', { notes: 'Office rule: never discount this.' }],
  ])('a rule whose %s an operator edited survives the rollback, with its edit and its pricing fields intact', async (_field, edit) => {
    const db = seeded();
    Object.assign(db.service_discount_rules.find((r) => r.service_key === KEY), edit);
    await rollBack(db);
    expect(keysLeft(db)).toEqual([KEY]);
    const kept = db.service_discount_rules.find((r) => r.service_key === KEY);
    expect(kept).toMatchObject(edit);
    // Only the note may differ from the edited row: no flag, cap or credit is changed by the guard.
    const { notes: _kept, ...keptFields } = kept;
    const { notes: _edited, ...editedFields } = { ...seeded().service_discount_rules.find((r) => r.service_key === KEY), ...edit };
    expect(keptFields).toEqual(editedFields);
  });

  test('only the edited rule is kept; its unedited neighbours are deleted', async () => {
    const db = seeded();
    db.service_discount_rules.find((r) => r.service_key === KEY).flat_credit = '10.00';
    await rollBack(db);
    expect(keysLeft(db)).toEqual([KEY]);
  });

  test('a kept rule is marked with the guard\'s note, and a second rollback pass leaves it alone', async () => {
    const db = seeded();
    db.service_discount_rules.find((r) => r.service_key === KEY).tier_qualifier = true;
    await rollBack(db);
    expect(db.service_discount_rules.find((r) => r.service_key === KEY).notes).toBe(guard.KEPT_NOTE);
    await guard.down(fakeKnex(db));
    expect(db.service_discount_rules.find((r) => r.service_key === KEY).notes).toBe(guard.KEPT_NOTE);
  });

  test('a missing table skips without error', async () => {
    await expect(guard.down(fakeKnex({}))).resolves.toBeUndefined();
  });
});
