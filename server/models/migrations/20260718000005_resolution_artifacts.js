/**
 * resolution_artifacts — distilled institutional memory (lane B of the
 * knowledge-retrieval scope).
 *
 * One row per resolved interaction: what was asked/found, the situation,
 * and how Waves resolved it — mapped WITHOUT an LLM from structure the
 * pipelines already produce (call_log.ai_extraction_enriched + triage/route
 * rows; service_findings + report AI summaries). Text fields are
 * PII-REDACTED at write time (same double-pass as voice_corpus_examples);
 * customer_id keeps the linkage without putting names in retrievable text.
 *
 * Rows flow into knowledge_embeddings via the 'resolution' connector, where
 * hybrid search applies recency decay (observational knowledge expires;
 * curated corpora don't).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('resolution_artifacts')) return;
  await knex.schema.createTable('resolution_artifacts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('source', 20).notNullable(); // 'call' | 'visit'
    t.uuid('source_id').notNullable();    // call_log.id | service_records.id
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.text('question').notNullable();     // what was asked / what the visit addressed
    t.text('situation');                  // redacted context summary
    t.text('resolution').notNullable();   // what we did / recommended
    t.jsonb('outcome').notNullable().defaultTo('{}');
    t.jsonb('systems').notNullable().defaultTo('[]'); // service categories, pests, natures
    t.timestamp('occurred_at').notNullable();
    t.string('schema_version', 20).notNullable().defaultTo('resolution.v1');
    t.timestamps(true, true);

    t.unique(['source', 'source_id']);
    t.index(['customer_id']);
    t.index(['occurred_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('resolution_artifacts');
};
