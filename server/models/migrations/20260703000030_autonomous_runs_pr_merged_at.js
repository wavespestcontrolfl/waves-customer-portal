/**
 * autonomous_runs.astro_pr_merged_at — first-observed merge time of the
 * run's Astro PR (blog-engine audit, publisher/poller lane; Codex P1 on
 * #2293).
 *
 * An auto-merged run stays parked at completed_pending_review /
 * astro_pr_pending_merge for the 30–45 min the production deploy takes, so
 * a daily publish cap that counts only outcome='completed_published' can't
 * see merges in flight — with a backlog of Codex-clean PRs the poller could
 * exceed the cap by one merge per 2-minute tick until deployments caught
 * up. finalizeMerged stamps this column the first time it observes the PR
 * merged (auto- OR human-merged, before any pending return), and the
 * poller's day-cap counts pending runs with a same-ET-day marker alongside
 * finalized publishes.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('autonomous_runs', 'astro_pr_merged_at');
  if (has) return;
  await knex.schema.alterTable('autonomous_runs', (t) => {
    t.timestamp('astro_pr_merged_at');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('autonomous_runs', 'astro_pr_merged_at');
  if (!has) return;
  await knex.schema.alterTable('autonomous_runs', (t) => {
    t.dropColumn('astro_pr_merged_at');
  });
};
