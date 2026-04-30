/**
 * Call-triage PR1 — extension columns on call_log for the
 * extract → enrich → validate → route pipeline introduced in PR2/PR4.
 *
 * Purely additive: every new column is nullable. PR1 ships the schema
 * surface, no behavior change to the existing call-recording-processor.
 * PR2 fills `ai_extraction_enriched`, `ai_validation`, and the version
 * columns; PR4 reads them in the routing gate.
 *
 * Why all version/model columns NOW: when Virginia asks "why did the
 * pipeline schedule this?", we need the exact prompt + model + schema
 * version that produced the decision. Adding these later means a
 * generation of decisions with no provenance. Cheap now, expensive
 * later.
 *
 * See docs/call-triage-discovery.md §6, §8, §10, §12.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    // Stage 2 — deterministic enrichment output. Address Validation API
    // response, properCase'd names, lowercased email, normalized phone.
    // Caller-stated values from ai_extraction stay immutable; this is
    // the post-enrichment view.
    t.jsonb('ai_extraction_enriched');

    // Stage 3 — Anthropic validator output. Evidence-based booleans +
    // quotes, global vetoes, routing recommendation. Schema in §8 of
    // discovery doc.
    t.jsonb('ai_validation');

    // Stage status — tracked separately from processing_status so we
    // don't collapse the existing 'processed/voicemail/spam/etc.' enum
    // with the new pipeline's stage outcomes.
    t.string('enrichment_status', 50);   // not_provided | validated_accept | inferred_material_component | replaced_material_component | ambiguous | out_of_service_area | api_unavailable | ...
    t.string('address_status', 50);      // mirror of enrichment_status for the address sub-step (queryable without unpacking jsonb)
    t.string('review_status', 30);       // null | open | in_progress | resolved | dismissed (mirrors triage_items aggregate)

    // Provenance — every routing decision must be traceable to the
    // exact model/prompt/schema that produced the inputs.
    t.string('ai_extraction_model', 50);
    t.string('ai_extraction_prompt_version', 30);
    t.string('ai_validation_model', 50);
    t.string('ai_validation_prompt_version', 30);
    t.string('ai_validation_schema_version', 30);
    t.string('enrichment_version', 30);
  });

  // Index review_status so the Triage Inbox tab can pull "open" calls
  // without a sequential scan. Partial index keeps it small.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS call_log_review_status_open_idx
    ON call_log (review_status, created_at DESC)
    WHERE review_status IN ('open', 'in_progress')
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_review_status_open_idx');
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('ai_extraction_enriched');
    t.dropColumn('ai_validation');
    t.dropColumn('enrichment_status');
    t.dropColumn('address_status');
    t.dropColumn('review_status');
    t.dropColumn('ai_extraction_model');
    t.dropColumn('ai_extraction_prompt_version');
    t.dropColumn('ai_validation_model');
    t.dropColumn('ai_validation_prompt_version');
    t.dropColumn('ai_validation_schema_version');
    t.dropColumn('enrichment_version');
  });
};
