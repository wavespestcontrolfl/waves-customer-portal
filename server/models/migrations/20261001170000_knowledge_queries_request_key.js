/**
 * knowledge_queries.request_key — one key per "Add to knowledge gaps" box in
 * the Intelligence Bar (POST /admin/intelligence-bar/knowledge-gap). A retry
 * after a lost response sends the same key, and the unique index turns it
 * into a no-op, so one tap never counts twice in the weekly knowledge-gaps
 * email. NULL for every other writer (Postgres unique allows many NULLs).
 * Additive and nullable; no backfill.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('knowledge_queries', 'request_key'))) {
    await knex.schema.alterTable('knowledge_queries', (t) => {
      t.uuid('request_key').nullable().unique();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('knowledge_queries', 'request_key')) {
    await knex.schema.alterTable('knowledge_queries', (t) => {
      t.dropUnique(['request_key']);
      t.dropColumn('request_key');
    });
  }
};
