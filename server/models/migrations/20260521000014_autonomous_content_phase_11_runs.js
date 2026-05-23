/**
 * Autonomous Content Engine — Phase 11 schema (run audit).
 *
 * One table: autonomous_runs — one row per attempted run of the
 * autonomous-runner. Used for the daily digest, weekly action-mix
 * review, trust-build counter (per v3.1: first N successful publishes
 * per action type require human-approve regardless of QA), and
 * post-mortem when a run goes sideways.
 *
 * Rows are append-only. Updates only flip terminal state fields
 * (outcome, completed_at) — never the input snapshot.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('autonomous_runs');
  if (exists) return;

  await knex.schema.createTable('autonomous_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Inputs (immutable after insert).
    t.uuid('opportunity_id').references('id').inTable('opportunity_queue').onDelete('SET NULL');
    t.uuid('brief_id').references('id').inTable('content_briefs').onDelete('SET NULL');
    t.string('action_type', 60).notNullable();
    t.string('page_type', 40);
    t.boolean('shadow_mode').notNullable().defaultTo(true);
    //   true = compose + agent + gates, but don't publish (shadow week)
    //   false = full pipeline

    // Per-stage timings (ms). null = stage didn't run.
    t.integer('claim_ms');
    t.integer('brief_ms');
    t.integer('agent_ms');
    t.integer('uniqueness_gate_ms');
    t.integer('quality_gate_ms');
    t.integer('publish_ms');
    t.integer('index_submit_ms');
    t.integer('link_plan_ms');
    t.integer('total_ms');

    // Outcomes / state.
    t.string('outcome', 30).notNullable();
    //   completed_published | completed_pending_review |
    //   skipped_no_opportunity | skipped_gate_fail |
    //   skipped_shadow_mode | failed_agent | failed_publish | failed
    t.string('skip_reason', 100);
    t.text('failure_message');

    // Gate snapshot — what each gate returned.
    t.jsonb('uniqueness_gate_result').notNullable().defaultTo('{}');
    t.jsonb('quality_gate_result').notNullable().defaultTo('{}');
    t.jsonb('draft_payload').notNullable().defaultTo('{}');
    t.string('agent_id', 120);
    t.string('agent_session_id', 120);

    // Trust-build accounting. completed_published rows count
    // automatically; completed_pending_review rows count only after
    // explicit human approval is recorded here.
    t.integer('trust_build_count_after').notNullable().defaultTo(0);
    t.timestamp('trust_build_approved_at');
    t.string('trust_build_approved_by', 100);

    // Publication artifacts (when applicable).
    t.string('published_url', 500);
    t.string('astro_pr_url', 500);
    t.string('indexnow_status', 30);
    t.integer('link_tasks_queued').notNullable().defaultTo(0);

    // Reviewer trail when gates kicked it back.
    t.text('reviewer_notes');

    t.timestamp('claimed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at');
    t.timestamps(true, true);

    t.index('opportunity_id');
    t.index('brief_id');
    t.index('action_type');
    t.index('outcome');
    t.index('shadow_mode');
    t.index('claimed_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('autonomous_runs');
};
