/**
 * contact_correction_jobs.rebase_floor_id (codex #3413 r25; this file
 * previously added context_attached_at, retired in the same PR when the
 * timestamp-cutoff rebase was abandoned — filename kept so knex's
 * migration ledger stays consistent for environments that ran it).
 *
 * The floor is the highest DONE job id for the customer at the moment the
 * route captures the CAS baseline. The snapshot rebase overlays only
 * queue writes ABOVE the floor: jobs completed before the capture are by
 * definition either reflected in the snapshot or superseded by a
 * non-queue edit the snapshot holds — without the floor, a historical
 * chain (old job wrote A→B, admin later restored A) could rebase a fresh
 * baseline back to B. Expressed in job-id space, not time, because
 * completed_at carries the transaction clock, not commit visibility.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('contact_correction_jobs', 'rebase_floor_id')) return;
  await knex.schema.alterTable('contact_correction_jobs', (t) => {
    t.bigInteger('rebase_floor_id');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('contact_correction_jobs', 'rebase_floor_id'))) return;
  await knex.schema.alterTable('contact_correction_jobs', (t) => {
    t.dropColumn('rebase_floor_id');
  });
};
