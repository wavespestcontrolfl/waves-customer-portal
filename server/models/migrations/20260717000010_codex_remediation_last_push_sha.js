/**
 * Migration — record the commit SHA of the last PUSHED remediation round on
 * codex_remediation_state.
 *
 * The P2-only merge bar (codex-remediation p2OnlyMergeEligible) previously
 * treated rounds >= 1 as proof remediation improved the PR, but rounds also
 * counts attempts where the LLM produced no valid fix and NOTHING was pushed
 * (the retry/outage path) — so an outage streak could satisfy the bar and
 * auto-merge an all-P2 review with the branch never actually changed (Codex
 * round-9 P2 on PR #2816). Only the successful push path writes this column;
 * the bar now requires it in addition to the round count.
 *
 *   last_push_sha — commit SHA of the most recent remediation commit this
 *                   loop pushed to the PR branch; NULL on legacy rows and on
 *                   rows whose rounds were all failed attempts. The bar
 *                   requires it to EQUAL the head under review (a stale
 *                   pre-park value must not vouch for a head remediation
 *                   never touched); NULL keeps the bar closed (fail-closed)
 *                   until a round pushes.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (!(await knex.schema.hasColumn('codex_remediation_state', 'last_push_sha'))) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.string('last_push_sha', 64);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (await knex.schema.hasColumn('codex_remediation_state', 'last_push_sha')) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.dropColumn('last_push_sha');
    });
  }
};
