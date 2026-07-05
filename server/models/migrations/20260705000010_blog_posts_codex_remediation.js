/**
 * Migration — Codex auto-remediation state on blog_posts.
 *
 * When Codex leaves review findings on an autonomous blog PR, the publisher
 * refuses to merge (astro-publisher.assertCodexReviewClear throws
 * CODEX_REVIEW_REQUIRED) and the PR sits open forever. The remediation loop
 * (server/services/content/codex-remediation.js) reads the findings, patches
 * the draft on the same PR branch, and re-requests review. These columns let it
 * bound its own retries and park a post for human review once exhausted, so it
 * never re-fixes the same PR indefinitely.
 *
 *   codex_remediation_rounds  — fix rounds pushed so far (0 = untouched)
 *   codex_remediation_status  — none | remediating | parked
 *   codex_last_findings       — jsonb snapshot of the last findings acted on
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.integer('codex_remediation_rounds').notNullable().defaultTo(0);
    t.string('codex_remediation_status', 20).notNullable().defaultTo('none');
    t.jsonb('codex_last_findings');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.dropColumn('codex_remediation_rounds');
    t.dropColumn('codex_remediation_status');
    t.dropColumn('codex_last_findings');
  });
};
