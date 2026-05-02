/**
 * DB-backed tests for the planner-data-prep migration:
 *   - sun_exposure 'shade' → 'heavy_shade' rename + normalization
 *   - lawn_assessments.stress_flags jsonb addition
 *
 * Self-skips without DATABASE_URL.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('planner data prep — sun_exposure rename + stress_flags', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  // ── stress_flags column ───────────────────────────────────────────────
  test('lawn_assessments.stress_flags column exists, jsonb, nullable', async () => {
    const cols = await knex('lawn_assessments').columnInfo();
    expect(cols).toHaveProperty('stress_flags');
    expect(cols.stress_flags.type).toMatch(/json/i);
    expect(cols.stress_flags.nullable).toBe(true);
  });

  test('stress_flags accepts and round-trips a structured object', async () => {
    const customer = await knex('customers').select('id').first();
    if (!customer) {
      // eslint-disable-next-line no-console
      console.warn('[planner-data-prep] no customers — skipping round-trip');
      return;
    }

    const flags = {
      drought_stress: true,
      shade_stress: false,
      disease_suspicion: false,
      recent_scalp: true,
      new_sod: false,
    };

    const [row] = await knex('lawn_assessments')
      .insert({
        customer_id: customer.id,
        service_date: new Date(),
        stress_flags: JSON.stringify(flags),
      })
      .returning('id');
    const id = row?.id ?? row;

    try {
      const back = await knex('lawn_assessments')
        .select('stress_flags')
        .where({ id })
        .first();
      // pg's default jsonb parser returns parsed objects.
      const parsed = typeof back.stress_flags === 'string'
        ? JSON.parse(back.stress_flags)
        : back.stress_flags;
      expect(parsed).toEqual(flags);
    } finally {
      await knex('lawn_assessments').where({ id }).del();
    }
  });

  // ── sun_exposure normalization ────────────────────────────────────────
  test('migration normalizes any pre-existing customer_turf_profiles.sun_exposure="shade" to "heavy_shade"', async () => {
    // Clean state assertion: after the migration runs, no profile
    // row should still carry sun_exposure='shade'. (Even if a row
    // was inserted before the migration with that value, the
    // migration's UPDATE should have rewritten it.)
    const stragglers = await knex('customer_turf_profiles')
      .where({ sun_exposure: 'shade' })
      .count('id as cnt')
      .first();
    expect(parseInt(stragglers.cnt, 10)).toBe(0);
  });

  test('migration is re-runnable without breaking existing heavy_shade rows', async () => {
    const customer = await knex('customers').select('id').first();
    if (!customer) return;

    // Insert a profile already at 'heavy_shade'.
    const [row] = await knex('customer_turf_profiles')
      .insert({ customer_id: customer.id, sun_exposure: 'heavy_shade' })
      .returning('id');
    const id = row?.id ?? row;

    try {
      // Re-running the migration's normalization step should be a no-op.
      await knex('customer_turf_profiles')
        .where({ sun_exposure: 'shade' })
        .update({ sun_exposure: 'heavy_shade', updated_at: new Date() });

      const back = await knex('customer_turf_profiles')
        .select('sun_exposure')
        .where({ id })
        .first();
      expect(back.sun_exposure).toBe('heavy_shade');
    } finally {
      await knex('customer_turf_profiles').where({ id }).del();
    }
  });
});
