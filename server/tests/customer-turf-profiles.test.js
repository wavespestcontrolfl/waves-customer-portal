/**
 * DB-backed integration tests for PR 1.1's customer_turf_profiles
 * table and its UPSERT semantics. Exercises the migration directly
 * via knex (no supertest harness — same pattern as PR 0.4's drift
 * sweep tests).
 *
 * Self-skips without DATABASE_URL.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('customer_turf_profiles', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  test('schema has every column the API + plan engine will read', async () => {
    const cols = await knex('customer_turf_profiles').columnInfo();
    const required = [
      'id', 'customer_id',
      'grass_type', 'track_key', 'cultivar', 'sun_exposure',
      'lawn_sqft', 'irrigation_type',
      'municipality', 'county',
      'soil_test_date', 'soil_ph',
      'known_chinch_history', 'known_disease_history', 'known_drought_stress',
      'annual_n_budget_target',
      'active', 'created_at', 'updated_at',
    ];
    for (const c of required) {
      expect(cols).toHaveProperty(c);
    }
    expect(cols.customer_id.nullable).toBe(false);
    expect(cols.active.nullable).toBe(false);
  });

  test('unique constraint on customer_id (one profile per customer)', async () => {
    const customer = await knex('customers').select('id').first();
    if (!customer) {
      // eslint-disable-next-line no-console
      console.warn('[turf-profile] no customer fixture — skipping');
      return;
    }

    const [first] = await knex('customer_turf_profiles')
      .insert({ customer_id: customer.id, grass_type: 'st_augustine' })
      .returning(['id']);

    try {
      await expect(
        knex('customer_turf_profiles').insert({
          customer_id: customer.id,
          grass_type: 'bermuda',
        })
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await knex('customer_turf_profiles').where({ id: first.id }).del();
    }
  });

  test('FK CASCADE on customer delete', async () => {
    // Create an isolated customer + profile, then delete the customer.
    // Profile should disappear with it.
    const [customer] = await knex('customers')
      .insert({
        first_name: 'TurfTest',
        last_name: 'Cascade',
        email: `turftest-cascade-${Date.now()}@local.test`,
        phone: '9415559999',
        address_line1: '1 Cascade Test Ln',
        city: 'Test City',
        state: 'FL',
        zip: '00000',
      })
      .returning(['id']);

    await knex('customer_turf_profiles').insert({
      customer_id: customer.id,
      grass_type: 'zoysia',
    });

    let profileBefore = await knex('customer_turf_profiles')
      .where({ customer_id: customer.id })
      .first();
    expect(profileBefore).toBeTruthy();

    await knex('customers').where({ id: customer.id }).del();

    const profileAfter = await knex('customer_turf_profiles')
      .where({ customer_id: customer.id })
      .first();
    expect(profileAfter).toBeUndefined();
  });

  test('upsert pattern: insert when absent, update when present', async () => {
    const customer = await knex('customers').select('id').first();
    if (!customer) return;

    // Insert path.
    const initial = {
      customer_id: customer.id,
      grass_type: 'st_augustine',
      sun_exposure: 'full_sun',
      lawn_sqft: 18750,
      municipality: 'North Port',
      county: 'Sarasota',
      annual_n_budget_target: 4.0,
    };
    const [inserted] = await knex('customer_turf_profiles')
      .insert(initial)
      .returning('*');
    expect(inserted.grass_type).toBe('st_augustine');
    expect(inserted.lawn_sqft).toBe(18750);

    try {
      // Update path — same customer, edit a few fields.
      const [updated] = await knex('customer_turf_profiles')
        .where({ id: inserted.id })
        .update({
          lawn_sqft: 20000,
          known_chinch_history: true,
          updated_at: new Date(),
        })
        .returning('*');
      expect(updated.lawn_sqft).toBe(20000);
      expect(updated.known_chinch_history).toBe(true);
      // Untouched fields should be preserved.
      expect(updated.grass_type).toBe('st_augustine');
      expect(updated.municipality).toBe('North Port');
    } finally {
      await knex('customer_turf_profiles').where({ id: inserted.id }).del();
    }
  });

  test('booleans default to false; active defaults to true', async () => {
    const customer = await knex('customers').select('id').first();
    if (!customer) return;

    const [row] = await knex('customer_turf_profiles')
      .insert({ customer_id: customer.id })
      .returning('*');

    try {
      expect(row.known_chinch_history).toBe(false);
      expect(row.known_disease_history).toBe(false);
      expect(row.known_drought_stress).toBe(false);
      expect(row.active).toBe(true);
    } finally {
      await knex('customer_turf_profiles').where({ id: row.id }).del();
    }
  });
});
