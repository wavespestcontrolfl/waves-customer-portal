// Adds google_reviews.publish_claimed_until — a short-lived durable claim a
// testimonial publisher stamps (under the per-location sync advisory lock)
// before running the slow external publish. The missing-review reconcile
// skips rows with an unexpired claim, so a removal stamp cannot land while
// the review is mid-publication — WITHOUT the publisher holding an advisory
// lock (and its pooled connection) across provider calls. The claim expires
// on its own (publishers also clear it best-effort), so a crashed publisher
// only defers that row's stamping to the next hourly cycle.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) return;
  if (await knex.schema.hasColumn('google_reviews', 'publish_claimed_until')) return;
  await knex.schema.alterTable('google_reviews', (table) => {
    table.timestamp('publish_claimed_until', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) return;
  if (!(await knex.schema.hasColumn('google_reviews', 'publish_claimed_until'))) return;
  await knex.schema.alterTable('google_reviews', (table) => {
    table.dropColumn('publish_claimed_until');
  });
};
