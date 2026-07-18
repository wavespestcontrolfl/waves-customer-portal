/**
 * knowledge_embeddings — one shared retrieval index for the hybrid
 * (full-text + vector) knowledge search (lane A2 of the knowledge-retrieval
 * scope; PR #2841 was lane A1).
 *
 * Every corpus lands here through the knowledge-index connectors
 * (services/knowledge-index/connectors.js): one row per chunk, keyed
 * (source, source_id, chunk_index). `embedding` is NULL until the embed
 * pass runs — full-text over the chunk works either way, so a missing
 * OPENAI_API_KEY degrades recall, never availability. 1536 dims =
 * text-embedding-3-small (HNSW indexes cap at 2000 dims).
 *
 * The vector extension ships with Railway's Postgres image (verified
 * available 2026-07-17, pgvector 0.8.2). down() drops the table but
 * deliberately leaves the extension installed — other tables may adopt it.
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');

  if (!(await knex.schema.hasTable('knowledge_embeddings'))) {
    await knex.schema.createTable('knowledge_embeddings', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('source', 40).notNullable();
      t.string('source_id', 200).notNullable();
      t.integer('chunk_index').notNullable().defaultTo(0);
      t.string('title', 500);
      t.text('content').notNullable();
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.string('content_hash', 64).notNullable();
      t.specificType('embedding', 'vector(1536)');
      t.timestamp('embedded_at');
      t.timestamp('source_updated_at');
      t.timestamps(true, true);

      t.unique(['source', 'source_id', 'chunk_index']);
      t.index(['source']);
    });

    await knex.raw(`
      ALTER TABLE knowledge_embeddings ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(content, '')), 'B')
        ) STORED
    `);
    await knex.raw(
      'CREATE INDEX idx_knowledge_embeddings_fts ON knowledge_embeddings USING GIN (search_vector)'
    );
    await knex.raw(
      'CREATE INDEX idx_knowledge_embeddings_hnsw ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops)'
    );
    await knex.raw(
      "CREATE INDEX idx_knowledge_embeddings_pending ON knowledge_embeddings ((1)) WHERE embedding IS NULL"
    );
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('knowledge_embeddings');
};
