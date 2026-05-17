exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('mileage_log');
  if (!hasTable) return;

  await knex.raw(`
    ALTER TABLE mileage_log
    ALTER COLUMN avg_speed_mph TYPE numeric(6,1)
    USING avg_speed_mph::numeric(6,1)
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('mileage_log');
  if (!hasTable) return;

  await knex.raw(`
    ALTER TABLE mileage_log
    ALTER COLUMN avg_speed_mph TYPE integer
    USING ROUND(avg_speed_mph)::integer
  `);
};
