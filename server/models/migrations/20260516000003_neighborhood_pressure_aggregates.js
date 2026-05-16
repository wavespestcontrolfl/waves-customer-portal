exports.up = async function up(knex) {
  if (await knex.schema.hasTable('neighborhood_pressure_aggregates')) return;

  await knex.schema.createTable('neighborhood_pressure_aggregates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('county');
    t.text('postal_code');
    t.string('service_line', 40).notNullable();
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.decimal('avg_pressure_index', 3, 1).notNullable();
    t.decimal('median_pressure_index', 3, 1);
    t.integer('sample_size').notNullable();
    t.timestamps(true, true);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uniq_neighborhood_pressure_period
    ON neighborhood_pressure_aggregates (
      COALESCE(county, ''),
      COALESCE(postal_code, ''),
      service_line,
      period_start,
      period_end
    )
  `);

  await knex.raw(`
    CREATE INDEX idx_neighborhood_pressure_lookup
    ON neighborhood_pressure_aggregates (
      county,
      postal_code,
      service_line,
      period_start DESC
    )
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_neighborhood_pressure_lookup');
  await knex.raw('DROP INDEX IF EXISTS uniq_neighborhood_pressure_period');
  await knex.schema.dropTableIfExists('neighborhood_pressure_aggregates');
};
