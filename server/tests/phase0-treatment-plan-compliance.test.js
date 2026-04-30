/**
 * Phase 0 smoke tests — treatment-plan compliance foundation.
 *
 * Just enough coverage to catch a broken migration before it ships:
 *   - the three seeded FL jurisdictions exist with the expected
 *     restricted-season windows and nutrient flags
 *   - provenance fields (source_url / source_name / source_checked_at)
 *     are populated on every active row
 *   - products_catalog gained the label/compliance columns the plan
 *     engine will read
 *   - service_products gained the plan-vs-actual columns
 *   - the partial unique index blocks two active rules for the same
 *     jurisdiction (so a second rule has to deactivate the first)
 *
 * No plan-engine logic is tested here — that lands with later phases.
 * These are pure schema/seed smoke tests against the local dev DB.
 *
 * Skipped in CI when DATABASE_URL isn't set so unit tests can still run
 * on a developer box without Postgres.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('phase0 treatment-plan compliance foundation', () => {
  let knex;

  beforeAll(() => {
    // Late require so a missing DATABASE_URL skips cleanly without
    // pg trying to bind in module init.
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  // ── municipality_ordinances seed ───────────────────────────────────────
  test('seeds the three FL jurisdictions', async () => {
    const rows = await knex('municipality_ordinances')
      .where({ active: true })
      .orderBy('jurisdiction_type')
      .orderBy('jurisdiction_name');

    const byName = Object.fromEntries(rows.map((r) => [r.jurisdiction_name, r]));
    expect(Object.keys(byName).sort()).toEqual(
      ['Manatee County', 'North Port', 'Sarasota County']
    );

    // Sarasota County: Jun 1 – Sep 30, N/P restricted, P needs soil test.
    expect(byName['Sarasota County']).toMatchObject({
      jurisdiction_type: 'county',
      county: 'Sarasota',
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      restricted_nitrogen: true,
      restricted_phosphorus: true,
      phosphorus_requires_soil_test: true,
    });

    // North Port: BROADER window (Apr 1 – Sep 30); city overlay on Sarasota County.
    expect(byName['North Port']).toMatchObject({
      jurisdiction_type: 'city',
      city: 'North Port',
      county: 'Sarasota',
      restricted_start_month: 4,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      restricted_nitrogen: true,
      restricted_phosphorus: true,
    });

    // Manatee County: Jun 1 – Sep 30, P year-round without soil test.
    expect(byName['Manatee County']).toMatchObject({
      jurisdiction_type: 'county',
      county: 'Manatee',
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      phosphorus_requires_soil_test: true,
    });
  });

  test('every active ordinance carries provenance', async () => {
    const rows = await knex('municipality_ordinances').where({ active: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.source_url).toMatch(/^https?:\/\//);
      expect(r.source_name).toBeTruthy();
      expect(r.source_checked_at).toBeTruthy();
    }
  });

  test('partial unique index blocks two active rules for one jurisdiction', async () => {
    // Try to insert a duplicate active Sarasota County row — should fail.
    await expect(knex('municipality_ordinances').insert({
      jurisdiction_name: 'Sarasota County',
      jurisdiction_type: 'county',
      county: 'Sarasota',
      state: 'FL',
      source_url: 'https://example.invalid/dupe',
      source_name: 'Dup test',
      source_checked_at: new Date(),
      active: true,
    })).rejects.toThrow(/duplicate key|unique/i);
  });

  test('inactive duplicates ARE allowed (history rows)', async () => {
    // Inserting an inactive row for the same jurisdiction must NOT collide
    // with the active one — supports rule history without violating the
    // partial unique index. Inserted, then deleted to keep the suite clean.
    const [{ id }] = await knex('municipality_ordinances').insert({
      jurisdiction_name: 'Sarasota County',
      jurisdiction_type: 'county',
      county: 'Sarasota',
      state: 'FL',
      source_url: 'https://example.invalid/historic',
      source_name: 'Historic test',
      source_checked_at: new Date(),
      active: false,
    }).returning('id');
    expect(id).toBeTruthy();
    await knex('municipality_ordinances').where({ id }).del();
  });

  // ── products_catalog new columns ───────────────────────────────────────
  test('products_catalog has the label/compliance columns', async () => {
    const cols = await knex('products_catalog').columnInfo();
    const expected = [
      'nitrogen_pct', 'phosphorus_pct', 'potassium_pct', 'slow_release_n_pct',
      'label_max_rate', 'label_max_rate_unit', 'label_min_interval_days',
      'label_annual_max_per_1000', 'label_annual_max_unit',
      'requires_soil_test', 'restricted_use_pesticide',
      'approved_for_turf_types', 'frac_group', 'irac_group',
      'product_label_url', 'label_revision_date', 'label_checked_at',
    ];
    for (const c of expected) {
      expect(cols).toHaveProperty(c);
    }
    // Defaults that matter for plan-engine safety:
    expect(cols.requires_soil_test.defaultValue).toMatch(/false/);
    expect(cols.restricted_use_pesticide.defaultValue).toMatch(/false/);
  });

  // ── service_products new columns ───────────────────────────────────────
  test('service_products has plan-vs-actual columns', async () => {
    const cols = await knex('service_products').columnInfo();
    expect(cols).toHaveProperty('planned_amount');
    expect(cols).toHaveProperty('planned_unit');
    expect(cols).toHaveProperty('treatment_plan_item_id');
    expect(cols).toHaveProperty('variance_reason');
    // FK target intentionally absent — treatment_plan_items doesn't
    // exist yet. Column should be plain uuid, nullable.
    expect(cols.treatment_plan_item_id.nullable).toBe(true);
  });
});
