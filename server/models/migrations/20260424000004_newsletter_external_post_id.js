/**
 * Adds external_post_id + external_source columns on newsletter_sends so we
 * can dedupe when importing historical campaigns from Beehiiv (or any other
 * external sender). external_post_id is unique where present — repeated imports
 * upsert instead of inserting duplicates.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (t) => {
    t.string('external_post_id').unique();
    t.string('external_source');
    t.text('external_web_url');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (t) => {
    t.dropUnique(['external_post_id']);
    t.dropColumn('external_post_id');
    t.dropColumn('external_source');
    t.dropColumn('external_web_url');
  });
};
