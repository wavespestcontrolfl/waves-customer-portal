/**
 * blog_posts.astro_retire_pr_number — the Astro PR the publisher still owes
 * GitHub a close for after a merge-time topic-targeting block parked the row
 * (publish_failed). Stamped in the same write as the park; cleared only once
 * the PR is verified closed (or found merged, in which case the row follows
 * the merge). pages-poll reconciles every tick, so a swallowed close failure
 * cannot leave a rejected PR human-mergeable.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('blog_posts', 'astro_retire_pr_number');
  if (!has) {
    await knex.schema.alterTable('blog_posts', (t) => {
      t.integer('astro_retire_pr_number').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('blog_posts', 'astro_retire_pr_number');
  if (has) {
    await knex.schema.alterTable('blog_posts', (t) => {
      t.dropColumn('astro_retire_pr_number');
    });
  }
};
