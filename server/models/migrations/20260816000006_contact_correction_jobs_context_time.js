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

exports.down = async function down() {};
