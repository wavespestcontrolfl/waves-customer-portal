/** Public, city-level model history only; never customer observations or PII. */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pest_forecast_snapshots')) return;
  await knex.schema.createTable('pest_forecast_snapshots', t => {
    t.string('location_slug', 80).notNullable();
    t.date('forecast_date').notNullable();
    t.string('model_version', 60).notNullable();
    t.timestamp('generated_at', { useTz: true }).notNullable();
    t.jsonb('forecast').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['location_slug', 'forecast_date', 'model_version']);
    t.index(['forecast_date', 'model_version']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pest_forecast_snapshots');
};
