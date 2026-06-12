/**
 * voice_corpus_examples — the brand-voice corpus (SMS brand-voice loop, Phase A).
 *
 * One row = one REDACTED exemplar of the Waves house voice:
 *   - source='sms_human_reply': a (customer message, human-authored reply)
 *     pair mined from sms_log manual sends — Virginia/Adam's real replies.
 *   - source='call_transcript': a diarized Agent:/Caller: labeled call
 *     transcript from call_log, consent-gated identically to the
 *     customer-insights-miner (strict disclaimer===true, inbound only).
 *
 * Text columns hold REDACTED content only ([name]/[phone]/[email]/[address]
 * via agent-decision-training redactText) — never raw PII. The Loop 2
 * distiller reads this table to update the voice profile; the nightly
 * judge (Phase C) does NOT — it reads live message_drafts shadow rows.
 *
 * UNIQUE (source, source_id) makes the nightly miner idempotent: re-runs
 * with an overlapping lookback window insert-ignore already-mined rows.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('voice_corpus_examples', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('source', 30).notNullable(); // 'sms_human_reply' | 'call_transcript'
    t.uuid('source_id').notNullable(); // sms_log.id of the reply / call_log.id
    t.uuid('customer_id').references('id').inTable('customers');
    t.uuid('admin_user_id'); // which human authored the reply (sms pairs)
    t.string('intent', 50); // classifyCustomerSmsTriageIntent class (sms pairs)
    t.text('inbound_text'); // redacted customer message (sms pairs)
    t.text('reply_text'); // redacted human reply (sms pairs)
    t.text('transcript_text'); // redacted labeled transcript (calls)
    t.jsonb('outcome'); // {customerReplied, optedOut, complaintWithin7d, callOutcome, ...}
    t.timestamp('occurred_at'); // when the reply was sent / the call happened
    t.string('schema_version', 30).notNullable().defaultTo('voice-corpus.v1');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique(['source', 'source_id']);
    t.index(['source', 'occurred_at']);
    t.index('intent');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('voice_corpus_examples');
};
