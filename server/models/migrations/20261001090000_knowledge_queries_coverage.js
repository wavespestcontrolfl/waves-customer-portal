/**
 * knowledge_queries.coverage — whether the answer the knowledge base gave
 * actually covered the question: 'full' | 'partial' | 'none' (NULL = not
 * recorded, e.g. rows from before this column). Feeds the weekly
 * knowledge-gaps email (services/knowledge/knowledge-gaps-weekly.js).
 * Additive and nullable; no backfill.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('knowledge_queries', 'coverage'))) {
    await knex.schema.alterTable('knowledge_queries', (t) => {
      t.string('coverage', 8).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('knowledge_queries', 'coverage')) {
    await knex.schema.alterTable('knowledge_queries', (t) => {
      t.dropColumn('coverage');
    });
  }
};
