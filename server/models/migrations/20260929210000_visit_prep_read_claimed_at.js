/**
 * Visit prep reads — when a read was CLAIMED, and an index for the daily
 * cap's scan.
 *
 * - `read_claimed_at` (timestamptz, nullable): stamped by every claim. A
 *   pending read is called failed 15 minutes after its claim, not after the
 *   submission: a read the recovery sweep claims long after the photos were
 *   sent must stay pending while it runs (Codex #5320 r10 P2). Rows claimed
 *   before this column fall back to created_at, as before.
 * - index on `created_at`: the daily-cap sum (visit-prep-read-claim.js
 *   readsToday) scans today's rows under the shared cap lock on every claim
 *   (Codex #5320 r10 P2).
 *
 * `hasColumn`-guarded and reversible, matching
 * 20260929190000_visit_prep_read_attempts.js.
 */

const INDEX = 'visit_prep_submissions_created_at_idx';

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('visit_prep_submissions', 'read_claimed_at');
  if (!has) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.timestamp('read_claimed_at', { useTz: true });
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDEX} ON visit_prep_submissions (created_at)`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  const has = await knex.schema.hasColumn('visit_prep_submissions', 'read_claimed_at');
  if (has) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.dropColumn('read_claimed_at');
    });
  }
};
