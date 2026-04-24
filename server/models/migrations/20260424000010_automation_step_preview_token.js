/**
 * Adds a stable preview_token to automation_steps so each step has a
 * shareable public URL (/api/public/automation-preview/:stepId/:token)
 * that renders the HTML with sample personalization — useful for
 * reviewing a step with a non-admin before enabling it.
 *
 * The token is random + unique; rotating it (set to gen_random_uuid())
 * invalidates any previously shared links.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('automation_steps', (t) => {
    t.uuid('preview_token').defaultTo(knex.raw('gen_random_uuid()')).unique();
  });
  // Backfill any rows that pre-date the default.
  await knex.raw(`UPDATE automation_steps SET preview_token = gen_random_uuid() WHERE preview_token IS NULL`);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('automation_steps', (t) => {
    t.dropUnique(['preview_token']);
    t.dropColumn('preview_token');
  });
};
