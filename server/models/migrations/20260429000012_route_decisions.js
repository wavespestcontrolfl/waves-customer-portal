/**
 * route_decisions — append-only immutable audit of every routing
 * decision the call-triage pipeline makes. Single object answering
 * "why did this call create this customer / estimate / appointment?"
 *
 * Shape per docs/call-triage-discovery.md §12. Two of the constraints
 * are load-bearing:
 *
 *   1. UNIQUE (call_log_id, decision_version, mode) — guarantees
 *      idempotency. Reprocessing the same CallSid with the same
 *      decision_version+mode is a no-op. Bumping decision_version
 *      lets us re-evaluate without colliding.
 *
 *   2. mode = 'shadow' | 'enforce' — PR2 ships the validator running
 *      in shadow (writes here, no behavior change). PR4 flips to
 *      enforce; the mode column lets us run a backtest by querying
 *      shadow rows against actual outcomes. Calibration data lives
 *      here.
 *
 * Reversible — table-only, no FK out from other PR1-shipped tables.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('route_decisions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');
    // ParentCallSid for forwarded inbound legs; CallSid otherwise.
    // Lets us dedupe routing across parent/child Twilio retries
    // without joining to call_log.
    t.string('source_call_group_id', 64);

    // Versioning — bump whenever routing rules change semantics.
    t.string('decision_version', 30).notNullable();
    t.string('mode', 20).notNullable();          // 'shadow' | 'enforce'

    // Decision narrative
    t.string('validator_recommendation', 50);    // 'auto_create_appointment' | 'auto_queue_draft_estimate' | 'upsert_customer_only' | 'needs_review'
    t.string('final_action_taken', 50);          // what we actually did (may differ from recommendation in shadow mode)
    t.jsonb('blocked_reasons');                  // list of veto codes
    t.jsonb('allowed_reasons');                  // list of green-light codes
    t.jsonb('field_write_plan');                 // candidates intended to be written
    t.jsonb('appointment_write_plan');           // null unless a scheduled_services row was planned/created
    t.jsonb('estimate_write_plan');              // same for estimates

    // Side-effect IDs (so we can audit forward from a decision to the rows it created)
    t.uuid('created_customer_id');
    t.uuid('created_estimate_id');
    t.uuid('created_scheduled_service_id');
    t.boolean('sms_enqueued').defaultTo(false);

    // Provenance — duplicates call_log.ai_validation_*  but pinned to
    // this decision row so a later prompt rev doesn't rewrite history.
    t.string('ai_validation_model', 50);
    t.string('ai_validation_prompt_version', 30);
    t.string('ai_validation_schema_version', 30);
    t.string('enrichment_version', 30);

    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['call_log_id', 'decision_version', 'mode']);
    t.index(['source_call_group_id']);
    t.index(['mode', 'created_at']);
    t.index(['validator_recommendation']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('route_decisions');
};
