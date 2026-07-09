/**
 * Migration — Codex remediation state, keyed by PR number.
 *
 * The remediation loop (server/services/content/codex-remediation.js) runs for
 * BOTH publish lanes: scheduler blog posts (a blog_posts row, reconciled by
 * pages-poll) AND autonomous publishes (an autonomous_runs row with NO
 * blog_posts row, reconciled by autonomous-pr-poller). Keying the round/attempt
 * state by PR number lets one store serve both lanes without touching either
 * table's schema.
 *
 *   pr_number      — the GitHub PR being remediated (unique)
 *   branch         — its head branch (for the fix commit)
 *   rounds         — fix rounds pushed so far (0 = untouched)
 *   status         — active | remediating | parked
 *   last_findings  — jsonb snapshot of the last findings acted on
 */

exports.up = async function (knex) {
  await knex.schema.createTable('codex_remediation_state', (t) => {
    t.increments('id').primary();
    t.integer('pr_number').notNullable().unique();
    t.string('branch');
    t.integer('rounds').notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('active');
    t.jsonb('last_findings');
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('codex_remediation_state');
};
