/**
 * og:image backfill bookkeeping: stamp when a row's event page was last
 * probed for an image so permanent failures (no og:image, dead page) are
 * retried on a 7-day backoff instead of re-fetched every run.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  if (await knex.schema.hasColumn('events_raw', 'image_backfill_attempted_at')) return;
  await knex.schema.alterTable('events_raw', (table) => {
    table.timestamp('image_backfill_attempted_at').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  if (!(await knex.schema.hasColumn('events_raw', 'image_backfill_attempted_at'))) return;
  await knex.schema.alterTable('events_raw', (table) => {
    table.dropColumn('image_backfill_attempted_at');
  });
};
