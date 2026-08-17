/**
 * RETIRED IN PLACE (codex #3413 r25/r26). This migration originally added
 * contact_correction_jobs.context_attached_at for a timestamp-cutoff
 * snapshot rebase that was abandoned within this same PR in favor of the
 * job-id-space rebase floor. The filename must survive for knex's
 * migration ledger (environments that ran the original shape have it
 * recorded), so it remains as a no-op: fresh environments add nothing,
 * and migration 20260816000007 adds rebase_floor_id and drops
 * context_attached_at wherever the original shape ran.
 */

exports.up = async function up() {};

// Rolling back BOTH 000007 and 000006 must land before-000006 schema:
// 000007.down() recreates context_attached_at (the state right after the
// original 000006), so this down() drops it again (codex #3413 r41).
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('contact_correction_jobs', 'context_attached_at')) {
    await knex.schema.alterTable('contact_correction_jobs', (t) => {
      t.dropColumn('context_attached_at');
    });
  }
};
