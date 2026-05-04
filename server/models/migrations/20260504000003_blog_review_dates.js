/**
 * Add explicit review/fact-check dates for Astro blog frontmatter.
 *
 * Reviewer names alone are not proof of a review event. These dates must be
 * filled intentionally by an admin before they are emitted publicly.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.date('technically_reviewed_at');
    t.date('fact_checked_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.dropColumn('technically_reviewed_at');
    t.dropColumn('fact_checked_at');
  });
};
