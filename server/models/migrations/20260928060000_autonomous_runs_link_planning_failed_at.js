/**
 * autonomous_runs.link_planning_failed_at — a retry marker for post-merge
 * internal-link planning.
 *
 * When a new autonomous blog post merges, the PR poller plans inbound links
 * to it (finalizeMerged → planInternalLinksForTarget). A transient failure
 * there (protected-registry or corpus outage) had no retry route: the post is
 * terminally published and link_tasks_queued is NOT NULL DEFAULT 0, so a
 * failed plan was indistinguishable from "planned zero links". The poller now
 * stamps this column on a failed or un-runnable plan; the daily candidate
 * sweep replans stamped runs and clears it on success.
 *
 * Additive and nullable: existing rows read NULL (= nothing to retry).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;
  if (await knex.schema.hasColumn('autonomous_runs', 'link_planning_failed_at')) return;
  await knex.schema.alterTable('autonomous_runs', (t) => {
    t.timestamp('link_planning_failed_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;
  if (!(await knex.schema.hasColumn('autonomous_runs', 'link_planning_failed_at'))) return;
  await knex.schema.alterTable('autonomous_runs', (t) => {
    t.dropColumn('link_planning_failed_at');
  });
};
