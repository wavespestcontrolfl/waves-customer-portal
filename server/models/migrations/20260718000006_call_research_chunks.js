/**
 * call_research_chunks — the voice-of-customer research corpus.
 *
 * Verbatim (PII-redacted) quote chunks mined nightly from call transcripts,
 * tagged with a fixed research taxonomy (need / objection / capability
 * question / ...). Sibling of resolution_artifacts (lane B: what we DID;
 * this table: what customers SAID) and voice_corpus_examples (how WE talk).
 * Quotes and context are double-redacted before every insert — no customer
 * names ever land in this table.
 *
 * call_log gains two stamp columns so the miner is idempotent and re-mines
 * automatically on a prompt-version bump: research_mined_at claims a call
 * (zero-chunk calls still get stamped so robocalls aren't re-mined forever),
 * research_prompt_version records which prompt produced the chunks.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_research_chunks'))) {
    await knex.schema.createTable('call_research_chunks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('call_log_id').notNullable()
        .references('id').inTable('call_log').onDelete('CASCADE');
      // Linkage kept for future joins; NEVER surfaced in v1 tool output.
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.integer('chunk_index').notNullable();
      t.string('speaker', 10); // 'caller' | 'agent'
      t.text('quote').notNullable(); // REDACTED verbatim speech
      t.text('context'); // REDACTED 1-2 surrounding sentences
      t.string('tag', 30).notNullable(); // controlled vocab, enum enforced in the extraction schema
      t.jsonb('topics').notNullable().defaultTo('[]'); // free-text topic strings
      t.string('service_mentioned', 50); // catalog service name when clear
      t.jsonb('segment_refs'); // diarized segment ids + ms offsets (jump-to-audio)
      t.timestamp('occurred_at').notNullable(); // call start time
      t.string('extraction_model', 80);
      t.string('prompt_version', 30);
      t.string('schema_version', 30).notNullable().defaultTo('call-research.v1');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.unique(['call_log_id', 'chunk_index']);
      t.index('call_log_id');
      t.index(['tag', 'occurred_at']);
    });

    // Same generated-column FTS pattern as knowledge_base (081) and
    // knowledge_entries (20260718000002): quote weight A, context weight B.
    await knex.raw(`
      ALTER TABLE call_research_chunks ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(quote, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(context, '')), 'B')
        ) STORED
    `);
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_call_research_chunks_search ON call_research_chunks USING GIN (search_vector)'
    );
  }

  if (!(await knex.schema.hasColumn('call_log', 'research_mined_at'))) {
    await knex.schema.alterTable('call_log', (t) => {
      t.timestamp('research_mined_at');
    });
  }
  if (!(await knex.schema.hasColumn('call_log', 'research_prompt_version'))) {
    await knex.schema.alterTable('call_log', (t) => {
      t.string('research_prompt_version', 30);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('call_log', 'research_prompt_version')) {
    await knex.schema.alterTable('call_log', (t) => {
      t.dropColumn('research_prompt_version');
    });
  }
  if (await knex.schema.hasColumn('call_log', 'research_mined_at')) {
    await knex.schema.alterTable('call_log', (t) => {
      t.dropColumn('research_mined_at');
    });
  }
  await knex.schema.dropTableIfExists('call_research_chunks');
};
