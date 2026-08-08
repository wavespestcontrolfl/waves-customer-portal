// Adds the DURABLE testimonial-published marker to google_reviews:
//   - testimonial_published_at: stamped (first-win) the moment ANY external
//     channel successfully posts this review as a testimonial — before and
//     independent of the review_graphics bookkeeping row. Candidate
//     selection and the publish-time consumed check both reject stamped
//     rows, so a failed/crashed bookkeeping write (or an in-memory recovery
//     loop dying with the process) can no longer reopen the review for a
//     second publish. The short-lived publish_claimed_until claim guards
//     the in-flight window; this column is the permanent record.
//   - testimonial_published_run: the owning studio run — a PARTIAL approval
//     publish (e.g. Facebook posted, Instagram failed) stamps ownership so
//     only that run's retry may publish the remaining channels; every other
//     run is rejected as consumed.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) return;
  if (!(await knex.schema.hasColumn('google_reviews', 'testimonial_published_at'))) {
    await knex.schema.alterTable('google_reviews', (table) => {
      table.timestamp('testimonial_published_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('google_reviews', 'testimonial_published_run'))) {
    await knex.schema.alterTable('google_reviews', (table) => {
      table.text('testimonial_published_run').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('google_reviews'))) return;
  if (await knex.schema.hasColumn('google_reviews', 'testimonial_published_run')) {
    await knex.schema.alterTable('google_reviews', (table) => {
      table.dropColumn('testimonial_published_run');
    });
  }
  if (await knex.schema.hasColumn('google_reviews', 'testimonial_published_at')) {
    await knex.schema.alterTable('google_reviews', (table) => {
      table.dropColumn('testimonial_published_at');
    });
  }
};
