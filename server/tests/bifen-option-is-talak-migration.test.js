/**
 * 20261025140000: the pre-slab and trenching bifen_it option becomes the Atticus Talak 7.9 F bottle in the persisted
 * pricing_config rows, with the same values talstar_p got. Only rows still holding the Bifen I/T values are rewritten;
 * rows already on Talak (production, updated by hand 2026-10-25) or edited by an admin are left alone. down() restores
 * only what up() wrote.
 */
const migration = require('../models/migrations/20261025140000_bifen_option_is_talak');
const talstarMigration = require('../models/migrations/20261025130000_talstar_option_is_talak');
const constants = require('../services/pricing-engine/constants');

function fakeKnex(db) {
  const knex = (table) => {
    let cond = {};
    const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
    const q = {
      where(c) { cond = { ...cond, ...c }; return q; },
      forUpdate() { return q; },
      first: async () => { const hit = (db[table] || []).find(match); return hit ? { ...hit } : undefined; },
      update: async (patch) => { db[table] = db[table].map((r) => (match(r) ? { ...r, ...patch } : r)); },
      insert: async (row) => { db[table].push({ id: db[table].length + 1, ...row }); },
      del: async () => { db[table] = db[table].filter((r) => !match(r)); },
    };
    return q;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  return knex;
}

// The persisted shapes every migrated env carries (admin seed + 20260710000020 catalog names).
const PRESLAB_BIFEN = { container_oz: 128, container_cost: 41.53, margin_divisor: 0.5294, catalog_product_name: 'Bifen I/T', product_oz_per_10_sqft: 1 };
const TRENCH_BIFEN = { container_oz: 96, container_cost: 55, product_oz_per_finished_gallon_at_high_rate: 2, product_oz_per_finished_gallon_at_standard_rate: 1 };
const TALAK_PRESLAB = talstarMigration.TALAK_PRESLAB;
const TALAK_TRENCH = talstarMigration.TALAK_TRENCH;
const world = (preslab = PRESLAB_BIFEN, trench = TRENCH_BIFEN) => ({
  pricing_config: [
    { config_key: 'onetime_preslab', data: JSON.stringify({ usage_step_sqft: 100, products: { taurus_sc: { container_cost: 95, container_oz: 78 }, bifen_it: preslab } }) },
    { config_key: 'onetime_trenching', data: JSON.stringify({ floor: 600, products: { taurus_sc: { container_cost: 85, container_oz: 78 }, bifen_it: trench } }) },
  ],
  pricing_config_audit: [],
  pricing_changelog: [],
});
const rowOf = (db, key) => JSON.parse(db.pricing_config.find((r) => r.config_key === key).data);
const bifenOf = (db, key) => rowOf(db, key).products.bifen_it;

describe('bifen_it option is Talak migration', () => {
  test('bifen_it in constants.js carries the same Talak values as talstar_p and as this migration', () => {
    const pick = (p) => ({
      label: p.label, catalogProductName: p.catalogProductName, packageLabel: p.packageLabel, positioning: p.positioning,
      containerCost: p.containerCost, containerOz: p.containerOz, warnings: p.warnings,
    });
    const preslab = constants.SPECIALTY.preSlabTermiticide.products;
    expect(pick(preslab.bifen_it)).toEqual(pick(preslab.talstar_p));
    expect(TALAK_PRESLAB).toEqual({
      label: preslab.bifen_it.label,
      catalog_product_name: preslab.bifen_it.catalogProductName,
      package_label: preslab.bifen_it.packageLabel,
      positioning: preslab.bifen_it.positioning,
      container_cost: preslab.bifen_it.containerCost,
      container_oz: preslab.bifen_it.containerOz,
      warnings: preslab.bifen_it.warnings,
    });
    const trench = constants.SPECIALTY.trenching.products;
    expect(pick(trench.bifen_it)).toEqual(pick(trench.talstar_p));
    expect(TALAK_TRENCH).toEqual({
      label: trench.bifen_it.label,
      positioning: trench.bifen_it.positioning,
      container_cost: trench.bifen_it.containerCost,
      container_oz: trench.bifen_it.containerOz,
      warnings: trench.bifen_it.warnings,
    });
  });

  test('rewrites both seeded Bifen rows to Talak, keeps their other keys, records each once', async () => {
    const db = world();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.up(knex);

    expect(bifenOf(db, 'onetime_preslab')).toEqual({ margin_divisor: 0.5294, product_oz_per_10_sqft: 1, ...TALAK_PRESLAB });
    expect(bifenOf(db, 'onetime_trenching')).toEqual({
      product_oz_per_finished_gallon_at_high_rate: 2, product_oz_per_finished_gallon_at_standard_rate: 1, ...TALAK_TRENCH,
    });
    expect(rowOf(db, 'onetime_preslab').products.taurus_sc).toEqual({ container_cost: 95, container_oz: 78 });
    expect(rowOf(db, 'onetime_preslab').usage_step_sqft).toBe(100);
    expect(rowOf(db, 'onetime_trenching').floor).toBe(600);

    expect(db.pricing_config_audit).toHaveLength(2);
    for (const audit of db.pricing_config_audit) {
      expect(audit.changed_by).toBe(migration.TAG);
      expect(audit.reason).toMatch(/bifen i\/t as talak is fine/);
      expect(JSON.parse(audit.old_value).products.bifen_it).toEqual(
        audit.config_key === 'onetime_preslab' ? PRESLAB_BIFEN : TRENCH_BIFEN,
      );
    }
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject(migration.CHANGELOG);
  });

  test('rows already on Talak (production 2026-10-25) are left alone and get no record', async () => {
    const db = world({ ...PRESLAB_BIFEN, ...TALAK_PRESLAB }, { ...TRENCH_BIFEN, ...TALAK_TRENCH });
    const before = JSON.stringify(db.pricing_config);
    await migration.up(fakeKnex(db));
    expect(JSON.stringify(db.pricing_config)).toBe(before);
    expect(db.pricing_config_audit).toEqual([]);
    expect(db.pricing_changelog).toEqual([]);
  });

  test('rows an admin edited another way are left alone', async () => {
    const db = world({ ...PRESLAB_BIFEN, catalog_product_name: 'Some Other Bifenthrin' }, { ...TRENCH_BIFEN, container_cost: 60 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await migration.up(fakeKnex(db));
    warn.mockRestore();
    expect(bifenOf(db, 'onetime_preslab').catalog_product_name).toBe('Some Other Bifenthrin');
    expect(bifenOf(db, 'onetime_trenching').container_cost).toBe(60);
    expect(db.pricing_config_audit).toEqual([]);
    expect(db.pricing_changelog).toEqual([]);
  });

  test('a camelCase alias that db-bridge would prefer is dropped, not left to shadow the Talak value', async () => {
    const db = world({ catalogProductName: 'Bifen I/T', containerCost: 41.53, containerOz: 128, margin_divisor: 0.5294 });
    await migration.up(fakeKnex(db));
    const bifen = bifenOf(db, 'onetime_preslab');
    expect(bifen).not.toHaveProperty('catalogProductName');
    expect(bifen).not.toHaveProperty('containerCost');
    expect(bifen).not.toHaveProperty('containerOz');
    expect(bifen).toMatchObject(TALAK_PRESLAB);
  });

  test('down restores only rows up() wrote and still unchanged, then removes only its own records', async () => {
    const db = world();
    db.pricing_config_audit.push({ id: 99, config_key: 'onetime_preslab', changed_by: 'admin', reason: 'edit' });
    const knex = fakeKnex(db);
    await migration.up(knex);
    const trench = rowOf(db, 'onetime_trenching');
    trench.products.bifen_it = { ...trench.products.bifen_it, container_cost: 44 };
    db.pricing_config = db.pricing_config.map((r) => (r.config_key === 'onetime_trenching' ? { ...r, data: JSON.stringify(trench) } : r));

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await migration.down(knex);
    warn.mockRestore();
    expect(bifenOf(db, 'onetime_preslab')).toEqual(PRESLAB_BIFEN);
    expect(bifenOf(db, 'onetime_trenching').container_cost).toBe(44);
    expect(db.pricing_config_audit.map((r) => r.id)).toEqual([99]);
    expect(db.pricing_changelog).toEqual([]);
  });

  test('down on rows this migration never touched changes nothing; missing tables skip', async () => {
    const db = world({ ...PRESLAB_BIFEN, ...TALAK_PRESLAB }, { ...TRENCH_BIFEN, ...TALAK_TRENCH });
    const before = JSON.stringify(db.pricing_config);
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(JSON.stringify(db.pricing_config)).toBe(before);
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({ pricing_config_audit: [] }))).resolves.toBeUndefined();
  });
});
