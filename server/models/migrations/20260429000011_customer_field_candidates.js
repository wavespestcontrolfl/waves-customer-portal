/**
 * customer_field_candidates — staging layer for AI-derived customer
 * field writes. PR1 ships the table; PR4 makes canonical
 * `customers` mutations into promotions FROM candidates rather than
 * direct inserts.
 *
 * Rationale (docs/call-triage-discovery.md §10): a single hallucinated
 * call should not be able to silently poison a customer profile. Every
 * extraction-derived field write lands here first with full evidence
 * (extracted vs. enriched vs. recommended, source, reason code, who
 * promoted it). The Triage Inbox UI in PR3 surfaces pending candidates
 * for one-click accept/reject/edit.
 *
 * Reversible — `down()` drops the table. No FK dependencies are added
 * to other tables in PR1, so dropping is clean.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('customer_field_candidates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Source linkage — candidates can exist before a customer row does
    // (caller's first call), so customer_id is nullable. Promotion
    // backfills it after the customer is upserted.
    t.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('CASCADE');

    // What field, what values
    t.string('field_name', 60).notNullable();        // 'first_name', 'last_name', 'email', 'address_line1', ...
    t.text('extracted_value');                        // raw Gemini output
    t.text('enriched_value');                         // post-enrichment (e.g. properCase'd name, AV-canonical address)
    t.text('final_recommended_value');                // what the validator + rules say to write
    t.text('evidence_quote');                         // verbatim transcript span backing the claim

    // Provenance + scoring
    t.string('source', 30).notNullable();             // 'gemini' | 'enrichment' | 'validator' | 'human'
    t.decimal('confidence', 4, 3);                    // 0.000–1.000, nullable (booleans are primary)
    t.string('reason_code', 60);                      // 'present' | 'spelled_out' | 'partial_match' | 'not_present_in_transcript' | ...

    // Lifecycle
    t.string('status', 30).notNullable().defaultTo('pending'); // 'pending' | 'auto_applied' | 'rejected' | 'human_applied'
    t.timestamp('reviewed_at');
    t.string('reviewed_by', 100);                     // admin user id/email; null when auto_applied

    // Google-derived values are scoped to TTL per Maps Platform terms;
    // caller-stated and human-confirmed values leave this null.
    t.timestamp('expires_at');

    t.timestamps(true, true);

    t.index(['call_log_id']);
    t.index(['customer_id']);
    t.index(['status', 'created_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_field_candidates');
};
