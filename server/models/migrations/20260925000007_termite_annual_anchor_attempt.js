/**
 * Termite annual plan — installation-anchor attempt marker (Codex round 7
 * on #4819). 20260925000001..000006 are frozen (pushed; the preview DB has
 * already run them) and are never edited — this is a NEW additive migration.
 *
 * annual_prepay_terms.installation_anchor_attempted_at (timestamptz) — the
 * daily reconciliation's anchor pass (termite-annual-activation.js
 * anchorTermToInstallation) is bounded. A term whose anchor fails
 * permanently (an overlap with another prepay term, or a thrown error) used
 * to keep no ordering state, so more than `limit` of them re-selected the
 * same oldest batch every day and starved newer completed installations.
 * Stamped on every attempt; the pass orders least-recently-attempted first,
 * the same rotation the activation and delivery passes already use. Null on
 * every other term (the table is shared across every annual-prepay program).
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'installation_anchor_attempted_at')) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.timestamp('installation_anchor_attempted_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'installation_anchor_attempted_at'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.dropColumn('installation_anchor_attempted_at');
  });
};
