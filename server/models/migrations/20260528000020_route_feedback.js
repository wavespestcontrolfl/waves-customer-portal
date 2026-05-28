/**
 * route_feedback — human verdict on what the call pipeline did, captured from
 * the Triage Inbox (triaged calls) AND a new auto-routed review list. This is
 * the labeled dataset that powers calibration (Phase 2): per-flag accept rates
 * surface over-triaging; any deny on an auto-routed call is a bad auto-route.
 *
 * Decision-support only — nothing here changes routing automatically. Keyed by
 * call_log_id (one current verdict per call; re-review upserts). Links to the
 * route_decision and/or triage_item so calibration can attribute the verdict to
 * the flags/reasons that drove the gate without denormalizing them here.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('route_feedback', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');
    t.uuid('route_decision_id').references('id').inTable('route_decisions').onDelete('SET NULL');
    t.uuid('triage_item_id').references('id').inTable('triage_items').onDelete('SET NULL');

    // What the gate actually did, so calibration can split the confusion matrix.
    t.string('decision_kind', 20).notNullable();   // 'triaged' | 'auto_routed'
    t.string('verdict', 10).notNullable();         // 'accept' | 'deny'
    // Field-level: which parts the reviewer marked wrong (deny only).
    // e.g. ['name','address','service','scheduling','consent','spam_status','routing']
    t.jsonb('wrong_fields').notNullable().defaultTo('[]');
    t.string('note', 500);
    t.string('reviewed_by', 100);

    t.timestamps(true, true);

    // One current verdict per call — re-review upserts on this.
    t.unique(['call_log_id']);
    t.index(['decision_kind', 'verdict']);
    t.index(['created_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('route_feedback');
};
