/**
 * Migration 035 — Knowledge Base System
 *
 * Tables:
 *  - knowledge_base     (wiki articles — the compiled knowledge)
 *  - knowledge_sources  (raw source documents fed to the compiler)
 *  - knowledge_queries  (log of questions asked against the wiki)
 */

exports.up = function (knex) {
  return knex.schema

    // ── Wiki Articles ─────────────────────────────────────────────
    .createTable('knowledge_base', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('path').notNullable().unique(); // wiki/products/celsius-wg.md
      t.string('title').notNullable();
      t.string('category'); // services, products, protocols, compliance, equipment, pricing, customers, pests, turf, operations, competitive, index
      t.text('content');
      t.text('summary'); // 2-3 sentence summary
      t.jsonb('tags');    // ['herbicide', 'celsius', 'weed_control']
      t.jsonb('backlinks'); // paths this article links to
      t.jsonb('source_documents'); // which raw files compiled into this
      t.integer('word_count');
      t.timestamp('last_compiled');
      t.timestamp('last_verified'); // when a human verified accuracy
      t.integer('version').defaultTo(1);
      t.boolean('active').defaultTo(true);
      t.timestamps(true, true);

      t.index('category');
      t.index('active');
    })

    // ���─ Raw Source Documents ──────────────────────────────────────
    .createTable('knowledge_sources', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('filename').notNullable();
      t.string('file_path');
      t.string('file_type'); // xlsx, pdf, md, csv, txt, json
      t.text('description');
      t.boolean('processed').defaultTo(false);
      t.timestamp('processed_at');
      t.jsonb('articles_generated'); // which wiki articles came from this
      t.timestamps(true, true);
    })

    // ── Query Log ─────────────────────────────────────────────────
    .createTable('knowledge_queries', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('query');
      t.text('answer');
      t.jsonb('articles_referenced'); // which wiki articles were used
      t.string('asked_by'); // system_protocol, system_csr, admin_manual, tech_field
      t.integer('response_quality'); // 1-5 rating
      t.boolean('filed_back').defaultTo(false); // was answer filed back into wiki?
      t.timestamps(true, true);
    });
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('knowledge_queries')
    .dropTableIfExists('knowledge_sources')
    .dropTableIfExists('knowledge_base');
};
