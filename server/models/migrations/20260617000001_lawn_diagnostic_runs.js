/**
 * Durable server-side provenance for the Lawn Diagnostic v0.5 pipeline.
 *
 * /analyze writes one row per analysis (server-authored — never client claims). Persist
 * loads it by id to decide, with server-trusted proof, whether a report was genuinely
 * challenge-reviewed (multimodal_challenged + challenge passed) and may therefore carry
 * the GPT-5.5 customer summary on the published report. Without a matching run record,
 * persist falls back to the deterministic, confidence-gated summary.
 *
 * Binding is on findings_hash (the prospect flow applies no products, so the summary is a
 * function of the findings) so a stale/forged persist with different findings can't reuse
 * a challenge-reviewed summary.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lawn_diagnostic_runs')) return;
  await knex.schema.createTable('lawn_diagnostic_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('created_by_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    // multimodal_challenged | challenge_degraded | deterministic_fallback | minimal | manual
    t.string('perception_mode', 40).notNullable();
    t.string('challenge_status', 20).notNullable(); // passed | failed | not_run
    t.string('findings_source', 40).nullable();
    t.string('perception_model', 80).nullable();
    t.string('challenge_model', 80).nullable();
    t.string('writer_model', 80).nullable();
    t.string('prompt_version', 60).nullable();
    t.string('findings_hash', 64).nullable(); // sha256 hex of the normalized findings
    // The challenge-reviewed summary (only meaningful for multimodal_challenged + passed);
    // persist may restore it onto the published report after verifying findings_hash.
    t.text('customer_summary').nullable();
    t.timestamps(true, true);

    t.index(['created_by_technician_id', 'created_at']);
    t.index(['created_at']); // for TTL pruning of old run records
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lawn_diagnostic_runs');
};
