/**
 * Lawn visit assessment runs — the server-authored provenance row behind the
 * single-call visit assessment (GATE_LAWN_VISIT_ASSESSMENT,
 * services/lawn-visit-assessment.js).
 *
 * One row per lawn_assessments row the gated /assess path creates: which
 * provider answered (or that neither did — status 'unavailable' with the
 * reason), the prompt version and a hash of the perception input, the photo
 * rows it read, the evidence-first findings, the native stress severities and
 * raw scores the legacy columns were derived from, token / latency cost, and
 * — written by /confirm — the technician's review and the deterministic
 * reconciliation over the visit's products. Additive: no existing table or
 * column changes; a re-analyze is a fresh assessment row with its own run.
 * Mirrors lawn_diagnostic_runs (20260617000001), the staff tool's run record.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lawn_assessment_runs')) return;
  await knex.schema.createTable('lawn_assessment_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('assessment_id').notNullable().unique().references('id').inTable('lawn_assessments').onDelete('CASCADE');
    t.uuid('customer_id').notNullable();
    t.uuid('service_id').nullable();
    t.string('status', 20).notNullable(); // complete | unavailable
    t.string('provider', 20).nullable(); // gemini | openai (the leg that answered)
    t.string('requested_model', 80).nullable();
    t.boolean('fallback_used').notNullable().defaultTo(false);
    t.jsonb('failures').notNullable().defaultTo('[]'); // [{ provider, model, reason }]
    t.string('unavailable_reason', 80).nullable();
    t.string('prompt_version', 60).notNullable();
    t.string('context_hash', 64).notNullable(); // sha256 hex of the perception input
    t.jsonb('photo_ids').notNullable().defaultTo('[]'); // lawn_assessment_photos ids, in prompt order
    t.jsonb('photo_quality').notNullable().defaultTo('[]');
    t.jsonb('findings').notNullable().defaultTo('[]'); // after the naming gate
    t.jsonb('severities').nullable();
    t.jsonb('scores_raw').nullable();
    t.text('observations').nullable();
    t.jsonb('raw_response').nullable();
    t.integer('tokens_in').nullable();
    t.integer('tokens_out').nullable();
    t.integer('tokens_reasoning').nullable();
    t.integer('latency_ms').nullable();
    // Written by /confirm — the one overall technician review.
    t.jsonb('reviewed_findings').nullable();
    t.jsonb('added_details').nullable();
    t.jsonb('reconciliation').nullable();
    t.timestamp('reviewed_at', { useTz: true }).nullable();
    t.uuid('reviewed_by_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamps(true, true);

    t.index(['customer_id', 'created_at']);
    t.index(['service_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lawn_assessment_runs');
};
