/**
 * Estimate view tracking — add view_count + last_viewed_at columns.
 *
 * `viewed_at` already exists and is set on first view. These new columns
 * track every subsequent view so admin can see re-engagement trends.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.integer('view_count').defaultTo(0);
    t.timestamp('last_viewed_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('view_count');
    t.dropColumn('last_viewed_at');
  });
};
