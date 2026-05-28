/**
 * PR-A2 — Additional columns for v2 extraction shadow pipeline.
 *
 * - transcript_structured: diarized transcript with speaker labels and
 *   word-level timestamps from OpenAI gpt-4o-transcribe-diarize.
 * - ai_extraction_validation_errors: ajv validation errors from the
 *   two-pass validation pipeline (model-output + persisted schema).
 * - v2_extraction_status: extraction experiment status, separate from
 *   processing_status so dashboard queries are not affected.
 *
 * Existing columns used by v2 (already shipped in 20260429000010):
 *   ai_extraction_enriched (shadow v2 storage destination)
 *   ai_extraction_model, ai_extraction_prompt_version (provenance)
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.jsonb('transcript_structured');
    t.jsonb('ai_extraction_validation_errors');
    t.string('v2_extraction_status', 30);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('transcript_structured');
    t.dropColumn('ai_extraction_validation_errors');
    t.dropColumn('v2_extraction_status');
  });
};
