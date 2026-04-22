/**
 * SEO Diagnosis Agent — Phase 1 schema.
 *
 * Two tables:
 *   seo_diagnoses — one row per agent run. Stores the input (dateRange +
 *     rubric version), the output (ranked issues array), and the metadata
 *     the BI briefing will eventually pull (duration, tools_called).
 *
 *   seo_decisions — the override-learning loop. When Adam/Virginia accepts,
 *     rejects, or modifies a recommendation, we write a row here. Over
 *     months the agent weights feed off these — Waves-specific SEO that
 *     generic tools never learn.
 *
 * Mirror pattern: treatment_outcomes, knowledge_contradictions. Same idea,
 * different domain.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('seo_diagnoses', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Input
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.text('rubric_version').notNullable(); // maps to docs/seo/waves-seo-rubric.yaml#version
    t.jsonb('input_domains'); // array of domain strings pulled
    // Run metadata
    t.text('status').notNullable().defaultTo('running'); // running | complete | failed
    t.text('anthropic_session_id');
    t.integer('duration_seconds');
    t.jsonb('tools_called'); // ["fetch_gsc_data", ...]
    t.text('error_message');
    // Output
    t.jsonb('ranked_issues'); // [{ type, url, query, impact_score, effort_score, suggested_fix, autonomous_fixable }]
    t.integer('issue_count').defaultTo(0);
    t.decimal('estimated_traffic_impact', 12, 2); // sum of per-issue impact
    t.uuid('ran_by_admin_id').references('id').inTable('technicians');
    t.timestamps(true, true);
    t.index(['period_start', 'period_end']);
    t.index('status');
  });

  await knex.schema.createTable('seo_decisions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('diagnosis_id').references('id').inTable('seo_diagnoses').onDelete('SET NULL');
    // What the agent recommended
    t.text('issue_type').notNullable(); // missing_service_area_page | cannibalization | etc.
    t.text('target_url');
    t.text('target_query');
    t.jsonb('agent_recommendation'); // the raw suggested_fix the agent produced
    t.decimal('agent_impact_score', 6, 2);
    t.decimal('agent_effort_score', 6, 2);
    // What a human decided
    t.text('decision').notNullable(); // accepted | rejected | modified | deferred
    t.text('decision_reason');
    t.jsonb('modified_fix'); // present when decision = 'modified'
    t.uuid('decided_by_admin_id').references('id').inTable('technicians');
    t.timestamp('decided_at').defaultTo(knex.fn.now());
    // Outcome (filled later once the fix ships + metrics re-ingest)
    t.jsonb('outcome_metrics'); // { clicks_before, clicks_after, pos_before, pos_after, sampled_at }
    t.timestamps(true, true);
    t.index('issue_type');
    t.index(['decided_by_admin_id', 'decided_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_decisions');
  await knex.schema.dropTableIfExists('seo_diagnoses');
};
