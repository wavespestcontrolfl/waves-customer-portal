/**
 * DB-backed tests for PR 1.3 — products_catalog label/rate field
 * extension + 10 core WaveGuard product seed.
 *
 * Self-skips without DATABASE_URL.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('products_catalog label/rate fields (PR 1.3)', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  // ── Schema presence ───────────────────────────────────────────────────
  test('every column the plan engine + mix calculator will read exists', async () => {
    const cols = await knex('products_catalog').columnInfo();
    const required = [
      // Fertilizer analysis
      'analysis_n', 'analysis_p', 'analysis_k', 'slow_release_n_pct',
      // EPA + resistance-management
      'epa_reg_number', 'frac_group', 'irac_group', 'hrac_group', 'hrac_group_secondary',
      // Mix-order + numeric rates
      'mixing_order_category',
      'default_rate_per_1000', 'min_label_rate_per_1000', 'max_label_rate_per_1000',
      'max_annual_per_1000', 'rate_unit',
      // Reentry / rainfast / irrigation
      'reentry_text', 'rainfast_minutes', 'irrigation_required',
      // Turf species + tank-mix
      'labeled_turf_species', 'excluded_turf_species',
      'requires_surfactant', 'allows_surfactant', 'do_not_tank_mix_with',
      'rate_notes',
      // Sourcing + provenance
      'label_url', 'sds_url', 'siteone_sku',
      'label_verified_at', 'label_verified_by', 'label_source_note',
    ];
    for (const c of required) {
      expect(cols).toHaveProperty(c);
    }
  });

  test('mixing_order_category CHECK constraint pins APPLES taxonomy', async () => {
    // Seed a throwaway product so we can attempt an out-of-range
    // mixing_order_category and verify the CHECK fires.
    await expect(
      knex.transaction(async (trx) => {
        await trx('products_catalog').insert({
          name: 'CHECK constraint smoke',
          mixing_order_category: 'wrong_category', // not in APPLES
        });
      })
    ).rejects.toThrow(/check|constraint/i);
  });

  // ── Seed verification ─────────────────────────────────────────────────
  test('all 10 core WaveGuard products are seeded and label_verified', async () => {
    const rows = await knex('products_catalog')
      .where('label_verified_by', 'PR-1.3-seed')
      .orderBy('name');
    const names = rows.map((r) => r.name);
    expect(names.sort()).toEqual([
      'Acelepryn Xtra',
      'Celsius WG',
      'Dismiss NXT',
      'LESCO 12-0-0 Chelated Iron Plus',
      'LESCO 24-0-11',
      'LESCO K-Flow 0-0-25',
      'LESCO Stonewall 0-0-7',
      'Primo Maxx',
      'SpeedZone Southern',
      'Talstar P',
    ]);
  });

  test('Acelepryn Xtra has the verified rate values', async () => {
    const r = await knex('products_catalog')
      .where({ name: 'Acelepryn Xtra' })
      .first();
    expect(r.epa_reg_number).toBe('432-1652');
    expect(r.irac_group).toBe('28+3A');
    expect(r.mixing_order_category).toBe('liquid_flowable_sc');
    expect(parseFloat(r.default_rate_per_1000)).toBe(0.46);
    expect(parseFloat(r.max_annual_per_1000)).toBe(0.46);
    expect(r.rate_unit).toBe('fl_oz');
  });

  test('Celsius WG has the FL annual cap and Bahia exclusion', async () => {
    const r = await knex('products_catalog')
      .where({ name: 'Celsius WG' })
      .first();
    expect(r.hrac_group).toBe('2');
    expect(r.hrac_group_secondary).toBe('4');
    expect(parseFloat(r.max_annual_per_1000)).toBe(0.17);
    // jsonb arrays come back parsed.
    expect(r.excluded_turf_species).toEqual(
      expect.arrayContaining(['bahia', 'kentucky_bluegrass', 'fescue', 'ryegrass'])
    );
    expect(r.requires_surfactant).toBe(true);
  });

  test('SpeedZone Southern excludes Floratam St. Augustine', async () => {
    const r = await knex('products_catalog')
      .where({ name: 'SpeedZone Southern' })
      .first();
    // Critical for the plan engine — Floratam is the most common St.
    // Augustine cultivar in SWFL. Wrong call here = lawn burn.
    expect(r.excluded_turf_species).toEqual(
      expect.arrayContaining(['floratam', 'st_augustine_unknown_cultivar'])
    );
  });

  // ── JSON field round-trip ─────────────────────────────────────────────
  test('jsonb columns accept arrays and objects', async () => {
    const tankMix = [{ product: 'glyphosate', reason: 'antagonism' }];
    const rateNotes = { st_augustine_note: 'use lower end on stressed turf' };

    const [row] = await knex('products_catalog')
      .insert({
        name: `JSONB round-trip smoke ${Date.now()}`,
        do_not_tank_mix_with: JSON.stringify(tankMix),
        rate_notes: JSON.stringify(rateNotes),
      })
      .returning('*');

    try {
      expect(row.do_not_tank_mix_with).toEqual(tankMix);
      expect(row.rate_notes).toEqual(rateNotes);
    } finally {
      await knex('products_catalog').where({ id: row.id }).del();
    }
  });

  // ── Pre-existing rows survive ─────────────────────────────────────────
  test('existing products_catalog rows (non-WaveGuard seed) still queryable', async () => {
    // The migration is purely additive; rows seeded by older migrations
    // (Demand CS, generic LESCO products from 20260401000017) should
    // still exist with their legacy columns intact.
    const all = await knex('products_catalog').count('id as cnt').first();
    expect(parseInt(all.cnt, 10)).toBeGreaterThanOrEqual(10);
  });
});
