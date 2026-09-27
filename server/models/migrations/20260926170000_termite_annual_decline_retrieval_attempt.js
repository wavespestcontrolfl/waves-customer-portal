/**
 * Termite annual plan — portal-decline retrieval attempt marker (Codex r8 P2
 * on #4940). Additive; no earlier migration is edited.
 *
 * annual_prepay_terms.decline_retrieval_attempted_at (timestamptz) — the
 * daily reconciliation's portal-decline retrieval pass
 * (annual-prepay-renewals.js raisePendingDeclineRetrievalTasks) is bounded.
 * A term whose raise keeps failing (or keeps finding no task row) is not
 * settled, so it stays a candidate; without ordering state more than
 * `limit` of them would re-select the same batch every day and starve newer
 * declines. Stamped on every attempt; the pass orders least-recently-
 * attempted first — the same rotation the installation-anchor pass uses
 * (20260925000007_termite_annual_anchor_attempt). Null on every other term
 * (the table is shared across every annual-prepay program).
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table. The pass itself
 * probes the column and runs unordered-by-attempt without it.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'decline_retrieval_attempted_at')) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.timestamp('decline_retrieval_attempted_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'decline_retrieval_attempted_at'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.dropColumn('decline_retrieval_attempted_at');
  });
};
