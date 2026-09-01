/**
 * Step-3 investigator (Codex PR r16):
 *
 * 1. `seo_link_domains.investigate_claim_token` — the generation token a
 *    claim mints. `agent_state = 'investigating'` alone cannot bind a run's
 *    final write to its own claim: an owner Watch/Reject followed by Reopen
 *    returns the state under a fresh mandate, and a run that started before
 *    it must not finish on top of it. Reopen clears the token; the write
 *    phase and the failure defer compare it.
 * 2. Attempt-ledger indexes the failed-attempt refresh bucket relies on —
 *    the sweep joins active paths by `path_id` and filters failure-shaped
 *    outcomes inside the 90-day horizon by `(outcome, created_at)`.
 */
exports.up = async function up(knex) {
  const cols = await knex('seo_link_domains').columnInfo();
  if (!cols.investigate_claim_token) {
    await knex.schema.alterTable('seo_link_domains', (t) => {
      t.text('investigate_claim_token');
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS seo_link_attempts_path_id_idx ON seo_link_attempts (path_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS seo_link_attempts_outcome_created_at_idx ON seo_link_attempts (outcome, created_at)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS seo_link_attempts_outcome_created_at_idx');
  await knex.raw('DROP INDEX IF EXISTS seo_link_attempts_path_id_idx');
  await knex.raw('ALTER TABLE seo_link_domains DROP COLUMN IF EXISTS investigate_claim_token');
};
