/**
 * contact_correction_jobs.context_attached_at (codex #3413 r21): records
 * WHEN the CAS baseline was captured (the route's context stamp / payload
 * enqueue). The snapshot-rebase cuts on this instead of the reservation's
 * created_at — the baseline trails the reservation by the route's
 * media/customer-lookup awaits, and a queue write landing in that gap is
 * already reflected in the snapshot (or superseded by an admin edit the
 * snapshot correctly holds) and must not be overlaid.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('contact_correction_jobs', 'context_attached_at')) return;
  await knex.schema.alterTable('contact_correction_jobs', (t) => {
    t.timestamp('context_attached_at');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('contact_correction_jobs', 'context_attached_at'))) return;
  await knex.schema.alterTable('contact_correction_jobs', (t) => {
    t.dropColumn('context_attached_at');
  });
};
