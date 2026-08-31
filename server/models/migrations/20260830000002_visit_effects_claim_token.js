/**
 * visit_effects.claim_token — ownership token for the notification claim
 * (visit-group-scope.md §2 handoff rule; codex #3603 r10). A claim is a
 * lease: the claimant's random token is stored on the row, and the owner's
 * pre-send lease check and its finalize are predicated on the token, so a
 * reclaim after a stalled sender's lease expires cannot be raced by that
 * stale owner (no provider-level SMS idempotency exists). Idempotent,
 * reversible, no backfill (existing rows are terminal or stale-reclaimable).
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('visit_effects', 'claim_token');
  if (!has) {
    await knex.schema.alterTable('visit_effects', (t) => {
      t.string('claim_token', 64);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('visit_effects', 'claim_token');
  if (has) {
    await knex.schema.alterTable('visit_effects', (t) => {
      t.dropColumn('claim_token');
    });
  }
};
