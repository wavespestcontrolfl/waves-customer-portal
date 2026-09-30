/**
 * Visit prep reads — index for the daily cap's claim-day count.
 *
 * The cap now counts an engine attempt on the ET day its read is claimed
 * (visit-prep-read-claim.js readsToday: read_claimed_at >= today, or a
 * pre-column row by its created_at), so the recovery sweep's re-read of an
 * older submission is charged to the day it runs (Codex #5320 r12). This
 * index serves the read_claimed_at half of that scan, alongside
 * 20260929210000's created_at index.
 */

const INDEX = 'visit_prep_submissions_read_claimed_at_idx';

exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDEX} ON visit_prep_submissions (read_claimed_at)`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
