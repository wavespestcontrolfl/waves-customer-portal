/**
 * contact_correction_jobs.rebase_floor_id (codex #3413 r25/r26): the
 * highest DONE job id for the customer when the CAS baseline was
 * captured. The snapshot rebase overlays only queue writes ABOVE the
 * floor — jobs completed before the capture are either reflected in the
 * snapshot or superseded by a non-queue edit the snapshot holds, so a
 * historical chain (old job wrote A→B, admin later restored A) can never
 * replay onto a fresh baseline. Expressed in job-id space, not time,
 * because completed_at carries the transaction clock, not commit
 * visibility.
 *
 * Also drops the retired context_attached_at column (see 20260816000006)
 * on environments that ran its original shape.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('contact_correction_jobs', 'rebase_floor_id'))) {
    await knex.schema.alterTable('contact_correction_jobs', (t) => {
      t.bigInteger('rebase_floor_id');
    });
  }
  if (await knex.schema.hasColumn('contact_correction_jobs', 'context_attached_at')) {
    await knex.schema.alterTable('contact_correction_jobs', (t) => {
      t.dropColumn('context_attached_at');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('contact_correction_jobs', 'rebase_floor_id')) {
    await knex.schema.alterTable('contact_correction_jobs', (t) => {
      t.dropColumn('rebase_floor_id');
    });
  }
};
