/**
 * autonomous_runs.astro_retire_pr_number — mirrors blog_posts'
 * astro_retire_pr_number: a PR this run's own atomic merge left owing GitHub
 * a close. mergePrAtomic's settleAdvancedHead (github-client.js) publishes
 * the verified head and, if a push landed on the PR during the merge,
 * closes it as superseded inline; when that inline close itself fails
 * (`retired: false`), maybeAutoMerge stamps the PR number here so
 * reconcileHeadAdvancedPrs (autonomous-pr-poller.js) retries the close every
 * poll tick until GitHub confirms it. The run itself has already finalized
 * through finalizeMerged by the time this debt can exist — this column is
 * independent bookkeeping for the leftover open PR, never a run-outcome
 * field.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('autonomous_runs', 'astro_retire_pr_number');
  if (!has) {
    await knex.schema.alterTable('autonomous_runs', (t) => {
      t.integer('astro_retire_pr_number').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('autonomous_runs', 'astro_retire_pr_number');
  if (has) {
    await knex.schema.alterTable('autonomous_runs', (t) => {
      t.dropColumn('astro_retire_pr_number');
    });
  }
};
