'use strict';

/**
 * call_live_utterances: one row per FINAL utterance of a live call transcription
 * (GATE_LIVE_CALL_TRANSCRIPTION, owner 2026-11-16 "ok build all"; services/live-call-transcription.js).
 *
 * Twilio Real-Time Transcription posts each final utterance to /api/webhooks/twilio/live-transcription.
 * The transcription runs on the inbound caller's call (call_log.twilio_call_sid), so:
 *   call_sid          the caller's CallSid (joins call_log.twilio_call_sid).
 *   transcription_sid Twilio's GT… id for the session. (transcription_sid, sequence_id) is unique, so a
 *                     redelivered event inserts nothing.
 *   speaker           'caller' (inbound track) or 'staff' (outbound track: what the caller hears).
 *   text              the utterance AFTER the card-number scrub (utils/pan-scrub). The scrub runs over a
 *                     window of the call's recent utterances, so a card number read across two
 *                     utterances is masked too. An emptied utterance keeps its row with text ''.
 *   pan_masked        this row's text had a card number or a card code masked.
 *   spoken_at         Twilio's event Timestamp (UTC).
 *
 * No foreign key on purpose: this is the call's live log, and a call_log row must never be blocked by it.
 * Additive; down drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('call_live_utterances')) return;
  await knex.schema.createTable('call_live_utterances', (t) => {
    t.bigIncrements('id').primary();
    t.text('call_sid').notNullable();
    t.text('transcription_sid').notNullable();
    t.integer('sequence_id').notNullable();
    t.text('speaker').notNullable();
    t.text('text').notNullable().defaultTo('');
    t.decimal('confidence', 6, 5).nullable();
    t.text('language').nullable();
    t.boolean('pan_masked').notNullable().defaultTo(false);
    t.timestamp('spoken_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['transcription_sid', 'sequence_id'], { indexName: 'call_live_utterances_session_seq_uidx' });
    t.index(['call_sid', 'spoken_at'], 'call_live_utterances_call_spoken_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('call_live_utterances');
};
