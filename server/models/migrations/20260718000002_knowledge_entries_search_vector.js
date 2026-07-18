/**
 * Full-text search vector for knowledge_entries (agronomic wiki).
 *
 * knowledge_base has carried a generated search_vector + GIN index since
 * migration 081; knowledge_entries never got one, so unified knowledge
 * search stayed ILIKE-only on the wiki side. Same generated-column
 * pattern: title weight A, summary weight B, content weight C.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_entries'))) return;

  if (!(await knex.schema.hasColumn('knowledge_entries', 'search_vector'))) {
    await knex.raw(`
      ALTER TABLE knowledge_entries ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(content, '')), 'C')
        ) STORED
    `);
  }

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_knowledge_entries_search ON knowledge_entries USING GIN (search_vector)'
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('knowledge_entries'))) return;

  await knex.raw('DROP INDEX IF EXISTS idx_knowledge_entries_search');

  if (await knex.schema.hasColumn('knowledge_entries', 'search_vector')) {
    await knex.raw('ALTER TABLE knowledge_entries DROP COLUMN search_vector');
  }
};
