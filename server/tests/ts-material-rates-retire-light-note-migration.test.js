/**
 * 20260924020020 — corrects the pricing_config ts_material_rates note
 * ("Light is a downsell / Enhanced retired", the inverse of the current
 * ladder) via a real read-modify-write migration, mirroring
 * 20260809000001_ts_v47_density_palm_callback_knobs.js's contract exactly.
 * Admin-edited NUMERIC keys must survive untouched; only `note` changes,
 * and only when it still matches the known stale string.
 */
const migration = require('../models/migrations/20260924020020_ts_material_rates_retire_light_note');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      forUpdate() { return q; },
      orderBy() { return q; },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async insert(row) { rows().push({ id: rows().length + 1, ...row }); return [row]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t === 'pricing_config' || t === 'pricing_config_audit' };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const row = (data) => ({ config_key: 'ts_material_rates', data: JSON.stringify(data) });

describe('20260924020020 corrects the T&S material-rates note', () => {
  test('replaces the stale note; every other (admin-editable) key survives untouched', async () => {
    const db = {
      pricing_config: [row({
        fixed: 12.5, per_tree: 4, per_sqft: 0.055, light_factor: 0.8,
        density_light: 1.1, palm_per_palm_annual: 6,
        note: migration.OLD_NOTE,
      })],
      pricing_config_audit: [],
    };
    const knex = fakeKnex(db);
    await migration.up(knex);
    const stored = JSON.parse(db.pricing_config[0].data);
    expect(stored.note).toBe(migration.NEW_NOTE);
    // Admin-edited numeric knobs are byte-identical — this migration never
    // touches them.
    expect(stored).toMatchObject({
      fixed: 12.5, per_tree: 4, per_sqft: 0.055, light_factor: 0.8,
      density_light: 1.1, palm_per_palm_annual: 6,
    });
    expect(stored.note).not.toMatch(/downsell/);
    expect(stored.note).toMatch(/RETIRED/);
    expect(stored.note).not.toMatch(/Enhanced 9x \/ Premium 12x retired/);
    const audit = db.pricing_config_audit[0];
    expect(audit).toMatchObject({ config_key: 'ts_material_rates', changed_by: 'migration:20260924020020' });
  });

  test('an admin-edited note (not the known stale string) is never overwritten', async () => {
    const db = {
      pricing_config: [row({ fixed: 15, note: 'Owner rewrote this note by hand.' })],
      pricing_config_audit: [],
    };
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(JSON.parse(db.pricing_config[0].data).note).toBe('Owner rewrote this note by hand.');
    expect(db.pricing_config_audit).toHaveLength(0);
  });

  test('a rerun is a no-op (the note no longer matches OLD_NOTE)', async () => {
    const db = { pricing_config: [row({ fixed: 15, note: migration.OLD_NOTE })], pricing_config_audit: [] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.up(knex);
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(JSON.parse(db.pricing_config[0].data).note).toBe(migration.NEW_NOTE);
  });

  test('down() restores the stale note text ONLY when it still equals what up() wrote', async () => {
    const db = { pricing_config: [row({ fixed: 15, note: migration.OLD_NOTE })], pricing_config_audit: [] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.parse(db.pricing_config[0].data).note).toBe(migration.OLD_NOTE);
  });

  test('down() is a no-op when an admin edited the note after up() ran', async () => {
    const db = { pricing_config: [row({ fixed: 15, note: migration.OLD_NOTE })], pricing_config_audit: [] };
    const knex = fakeKnex(db);
    await migration.up(knex);
    db.pricing_config[0].data = JSON.stringify({ fixed: 15, note: 'Owner rewrote this after the deploy.' });
    await migration.down(knex);
    expect(JSON.parse(db.pricing_config[0].data).note).toBe('Owner rewrote this after the deploy.');
  });

  test('missing pricing_config table or row is a no-op both ways', async () => {
    const knex = fakeKnex({});
    knex.schema.hasTable = async () => false;
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});
