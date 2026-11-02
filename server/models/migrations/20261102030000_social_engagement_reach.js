// GATE_SOCIAL_REACH_INGEST (owner 2026-11-01): the daily engagement sweep also stores each Facebook
// post's and Instagram media's reach (people reached) and views (times shown). Both nullable on
// purpose: NULL = Meta did not give the number (unsupported media type, missing scope, gate off),
// distinct from a measured zero. Additive; no backfill.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('social_post_engagement'))) return;
  for (const column of ['reach', 'views']) {
    if (!(await knex.schema.hasColumn('social_post_engagement', column))) {
      await knex.schema.alterTable('social_post_engagement', (t) => {
        t.integer(column);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('social_post_engagement'))) return;
  for (const column of ['reach', 'views']) {
    if (await knex.schema.hasColumn('social_post_engagement', column)) {
      await knex.schema.alterTable('social_post_engagement', (t) => {
        t.dropColumn(column);
      });
    }
  }
};
