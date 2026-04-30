// PR 1.1 of the WaveGuard treatment-plan rollout.
//
// Foundation table for the WaveGuard plan engine. One row per customer:
// captures the agronomic facts that the plan engine needs to know
// before it can answer "what's allowed today" — turf species, sun
// exposure, lawn area, irrigation type, municipality (for ordinance
// lookup later), soil context, and known historical pressure.
//
// Stored separately from `customers` deliberately. Not every customer
// has lawn service (pest-only customers exist and never need a turf
// profile), and the column count would bloat the customer row for
// no payoff. The 1:1 join is fast enough.
//
// String columns are intentionally plain `string` rather than Postgres
// enums — the plan engine ships in a later PR and may evolve allowed
// values; an enum requires a migration to extend, a string with
// allowed-list validation in the API layer is friendlier for that
// iteration.
//
// Idempotent via hasTable guard.

exports.up = async function (knex) {
  if (await knex.schema.hasTable('customer_turf_profiles')) return;

  await knex.schema.createTable('customer_turf_profiles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // 1:1 link to customer. CASCADE delete because a turf profile
    // has no meaning without its customer; orphan rows would be a
    // pure liability.
    t.uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE')
      .onUpdate('CASCADE');

    // Agronomic identity.
    // grass_type:    'st_augustine' | 'bermuda' | 'zoysia' | 'bahia' | 'mixed' | 'unknown'
    // track_key:     WaveGuard v4 protocol track id (e.g. 'st_aug_full_sun', 'st_aug_shade').
    // sun_exposure:  'full_sun' | 'partial_shade' | 'shade'
    t.string('grass_type', 30).nullable();
    t.string('track_key', 40).nullable();
    t.string('cultivar', 60).nullable();
    t.string('sun_exposure', 20).nullable();

    // Lawn footprint. integer sq ft — turf is rarely measured below
    // the square-foot resolution and 32-bit handles plots up to ~2bn.
    t.integer('lawn_sqft').nullable();

    // irrigation_type: 'in_ground' | 'manual' | 'none' | 'mixed'
    t.string('irrigation_type', 20).nullable();

    // Jurisdiction context. Not a FK to municipality_ordinances yet —
    // that table doesn't exist on main (lives on the unmerged
    // compliance branch). Free-text for now; ordinance linkage is
    // PR 1.4's job.
    t.string('municipality', 80).nullable();
    t.string('county', 60).nullable();

    // Soil context.
    t.date('soil_test_date').nullable();
    t.decimal('soil_ph', 3, 1).nullable(); // 0.0 – 14.0; 1-decimal precision

    // Known pressure history. Used by the plan engine to bias
    // scouting/preventive product selection on the first visit of
    // each season.
    t.boolean('known_chinch_history').notNullable().defaultTo(false);
    t.boolean('known_disease_history').notNullable().defaultTo(false);
    t.boolean('known_drought_stress').notNullable().defaultTo(false);

    // FL-friendly default cap is 4.0 lb N / 1,000 sqft / yr for
    // warm-season turf (Sarasota / North Port / Manatee all adopt
    // this). null = defer to ordinance + label, which is the safest
    // initial state.
    t.decimal('annual_n_budget_target', 5, 2).nullable();

    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);

    // One profile per customer. Unique partial would let inactive
    // history rows coexist later, but for v1 we keep it strict —
    // `active=false` rows still occupy the unique slot, so deactivate
    // by deleting until we have a reason to keep history.
    t.unique('customer_id', 'idx_ctp_customer_unique');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_turf_profiles');
};
