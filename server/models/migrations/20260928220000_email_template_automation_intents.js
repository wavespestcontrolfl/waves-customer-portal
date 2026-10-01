/**
 * Durable "this lifecycle transition happened" markers for
 * email_template_automation_emitters.js's recovery sweep (codex round 3 on
 * #5154).
 *
 * Round 2's sweep re-derived "missed" events by guessing from entity
 * timestamps (estimates.updated_at / google_reviews.updated_at) against a
 * NOT EXISTS on email_template_automation_runs. That turned out to be
 * inherently ambiguous — an unrelated repair (a staff correction on an
 * already-linked review, an admin archiving an old expired estimate) bumps
 * the same timestamp with no new automation owed, and looked exactly like a
 * fresh event.
 *
 * This table is written in the SAME transaction as the transition that
 * earns it (the estimate-expiry flip, the review-attribution write), before
 * any further processing — recovery then means "replay every 'pending'
 * marker", never "guess from a timestamp again". See the file banner in
 * server/services/email-template-automation-emitters.js.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('email_template_automation_intents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('trigger_event_key', 120).notNullable();
    t.string('entity_type', 80).notNullable();
    t.string('entity_id', 120).notNullable();
    t.timestamp('occurred_at').notNullable().defaultTo(knex.fn.now());
    // pending | processed | unrecoverable
    t.string('status', 20).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.timestamps(true, true);

    t.unique(['trigger_event_key', 'entity_id', 'occurred_at']);
    t.index(['status', 'occurred_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_template_automation_intents');
};
