/**
 * blog_posts.astro_requires_human_merge — stamped by publishAstro from the
 * comparison/named-competitor gate's requiresHumanReview at evaluation time.
 *
 * TRUE means the post passed the gate but names curated competitors (a
 * validated <ComparisonTable>), which the policy allows to PUBLISH only under
 * a human sign-off. The admin lane has one (the publish/merge clicks); the
 * scheduler lane's unattended pages-poll auto-merge does not — it reads this
 * flag and withholds the merge, parking the claim for an admin to merge via
 * the merge-astro route (audit lane 4b follow-up to #2298/#2293).
 *
 * DEFAULT FALSE, not null-means-blocked: rows published before this column
 * existed keep the pre-4b behavior (Codex-gated auto-merge) instead of
 * freezing the whole scheduler lane at deploy time; every publishAstro run
 * after this migration stamps the flag explicitly.
 */
exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('blog_posts', 'astro_requires_human_merge');
  if (!has) {
    await knex.schema.alterTable('blog_posts', (t) => {
      t.boolean('astro_requires_human_merge').notNullable().defaultTo(false);
    });
  }
};

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('blog_posts', 'astro_requires_human_merge');
  if (has) {
    await knex.schema.alterTable('blog_posts', (t) => {
      t.dropColumn('astro_requires_human_merge');
    });
  }
};
