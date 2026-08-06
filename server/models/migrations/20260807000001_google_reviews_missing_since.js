// Adds google_reviews.missing_since — stamped by the hourly GBP sync when a
// previously-synced review stops appearing in the authoritative GBP Reviews
// API feed (Google removed/filtered it). Cleared automatically if the review
// reappears. Powers the removed-review admin alert (Aug 2026: the Venice
// profile lost ALL its reviews in a Google sweep and nothing noticed).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) return;
  if (await knex.schema.hasColumn('google_reviews', 'missing_since')) return;
  await knex.schema.alterTable('google_reviews', (table) => {
    table.timestamp('missing_since', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) return;
  if (!(await knex.schema.hasColumn('google_reviews', 'missing_since'))) return;
  await knex.schema.alterTable('google_reviews', (table) => {
    table.dropColumn('missing_since');
  });
};
