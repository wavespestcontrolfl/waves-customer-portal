/**
 * 20261025130000: the pre-slab and trenching talstar_p option becomes the Atticus Talak 7.9 F bottle in the persisted
 * pricing_config rows. Only rows still holding the Talstar values are rewritten; rows already on Talak (production,
 * updated by hand 2026-10-24) or edited by an admin are left alone. down() restores only what up() wrote.
 */
const migration = require('../models/migrations/20261025130000_talstar_option_is_talak');
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
const PRESLAB_TALSTAR = { container_oz: 128, container_cost: 38.99, margin_divisor: 0.5294, catalog_product_name: 'Talstar P', product_oz_per_10_sqft: 1 };
const TRENCH_TALSTAR = { container_oz: 96, container_cost: 65, product_oz_per_finished_gallon_at_high_rate: 2, product_oz_per_finished_gallon_at_standard_rate: 1 };
const preslabRow = (talstar) => ({
  usage_step_sqft: 100,
  link_container_costs_to_catalog: true,
  products: { termidor_sc: { container_cost: 174.72, container_oz: 78, catalog_product_name: 'Termidor SC' }, talstar_p: talstar },
});
const trenchRow = (talstar) => ({ floor: 600, products: { taurus_sc: { container_cost: 85, container_oz: 78 }, talstar_p: talstar } });
const world = (preslab = PRESLAB_TALSTAR, trench = TRENCH_TALSTAR) => ({
  pricing_config: [
    { config_key: 'onetime_preslab', data: JSON.stringify(preslabRow(preslab)) },
    { config_key: 'onetime_trenching', data: JSON.stringify(trenchRow(trench)) },
  ],
  pricing_config_audit: [],
  pricing_changelog: [],
});
const talstarOf = (db, key) => JSON.parse(db.pricing_config.find((r) => r.config_key === key).data).products.talstar_p;
const rowOf = (db, key) => JSON.parse(db.pricing_config.find((r) => r.config_key === key).data);

describe('talstar_p option is Talak migration', () => {
  test('the inlined Talak values match the talstar_p products in constants.js', () => {
    const preslab = constants.SPECIALTY.preSlabTermiticide.products.talstar_p;
    expect(migration.TALAK_PRESLAB).toEqual({
      label: preslab.label,
      catalog_product_name: preslab.catalogProductName,
      package_label: preslab.packageLabel,
      positioning: preslab.positioning,
      container_cost: preslab.containerCost,
      container_oz: preslab.containerOz,
      warnings: preslab.warnings,
    });
    const trench = constants.SPECIALTY.trenching.products.talstar_p;
    expect(migration.TALAK_TRENCH).toEqual({
      label: trench.label,
      positioning: trench.positioning,
      container_cost: trench.containerCost,
      container_oz: trench.containerOz,
      warnings: trench.warnings,
    });
  });

  test('rewrites both seeded Talstar rows to Talak, keeps their other keys, records each once', async () => {
    const db = world();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.up(knex);

    expect(talstarOf(db, 'onetime_preslab')).toEqual({ margin_divisor: 0.5294, product_oz_per_10_sqft: 1, ...migration.TALAK_PRESLAB });
    expect(talstarOf(db, 'onetime_trenching')).toEqual({
      product_oz_per_finished_gallon_at_high_rate: 2, product_oz_per_finished_gallon_at_standard_rate: 1, ...migration.TALAK_TRENCH,
    });
    // Sibling products and top-level keys are untouched.
    expect(rowOf(db, 'onetime_preslab').products.termidor_sc).toEqual(preslabRow(PRESLAB_TALSTAR).products.termidor_sc);
    expect(rowOf(db, 'onetime_preslab').usage_step_sqft).toBe(100);
    expect(rowOf(db, 'onetime_trenching').floor).toBe(600);

    expect(db.pricing_config_audit).toHaveLength(2);
    for (const audit of db.pricing_config_audit) {
      expect(audit.changed_by).toBe(migration.TAG);
      expect(audit.reason).toMatch(/swap talstar for talak/);
      expect(JSON.parse(audit.old_value).products.talstar_p).toEqual(
        audit.config_key === 'onetime_preslab' ? PRESLAB_TALSTAR : TRENCH_TALSTAR,
      );
    }
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject(migration.CHANGELOG);
  });

  test('rows already on Talak (production 2026-10-24) are left alone and get no record', async () => {
    const db = world(
      { ...PRESLAB_TALSTAR, ...migration.TALAK_PRESLAB },
      { ...TRENCH_TALSTAR, ...migration.TALAK_TRENCH },
    );
    const before = JSON.stringify(db.pricing_config);
    await migration.up(fakeKnex(db));
    expect(JSON.stringify(db.pricing_config)).toBe(before);
    expect(db.pricing_config_audit).toEqual([]);
    expect(db.pricing_changelog).toEqual([]);
  });

  test('rows an admin edited another way are left alone', async () => {
    const db = world(
      { ...PRESLAB_TALSTAR, catalog_product_name: 'Some Other Bifenthrin' },
      { ...TRENCH_TALSTAR, container_cost: 70 },
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await migration.up(fakeKnex(db));
    warn.mockRestore();
    expect(talstarOf(db, 'onetime_preslab').catalog_product_name).toBe('Some Other Bifenthrin');
    expect(talstarOf(db, 'onetime_trenching').container_cost).toBe(70);
    expect(db.pricing_config_audit).toEqual([]);
    expect(db.pricing_changelog).toEqual([]);
  });

  test('a camelCase alias that db-bridge would prefer is dropped, not left to shadow the Talak value', async () => {
    const db = world({ catalogProductName: 'Talstar P', containerCost: 38.99, containerOz: 128, margin_divisor: 0.5294 });
    await migration.up(fakeKnex(db));
    const talstar = talstarOf(db, 'onetime_preslab');
    expect(talstar).not.toHaveProperty('catalogProductName');
    expect(talstar).not.toHaveProperty('containerCost');
    expect(talstar).not.toHaveProperty('containerOz');
    expect(talstar).toMatchObject(migration.TALAK_PRESLAB);
  });

  test('down restores only rows up() wrote and still unchanged, then removes only its own records', async () => {
    const db = world();
    db.pricing_config_audit.push({ id: 99, config_key: 'onetime_preslab', changed_by: 'admin', reason: 'edit' });
    const knex = fakeKnex(db);
    await migration.up(knex);
    // An admin edits the trenching option after the migration: down must keep that edit.
    const trench = rowOf(db, 'onetime_trenching');
    trench.products.talstar_p = { ...trench.products.talstar_p, container_cost: 44 };
    db.pricing_config = db.pricing_config.map((r) => (r.config_key === 'onetime_trenching' ? { ...r, data: JSON.stringify(trench) } : r));

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await migration.down(knex);
    warn.mockRestore();
    expect(talstarOf(db, 'onetime_preslab')).toEqual(PRESLAB_TALSTAR);
    expect(talstarOf(db, 'onetime_trenching').container_cost).toBe(44);
    expect(db.pricing_config_audit.map((r) => r.id)).toEqual([99]);
    expect(db.pricing_changelog).toEqual([]);
  });

  test('down on a row this migration never touched changes nothing; missing tables skip', async () => {
    const db = world({ ...PRESLAB_TALSTAR, ...migration.TALAK_PRESLAB }, { ...TRENCH_TALSTAR, ...migration.TALAK_TRENCH });
    const before = JSON.stringify(db.pricing_config);
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));
    expect(JSON.stringify(db.pricing_config)).toBe(before);
    await expect(migration.up(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({}))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex({ pricing_config_audit: [] }))).resolves.toBeUndefined();
  });
});
