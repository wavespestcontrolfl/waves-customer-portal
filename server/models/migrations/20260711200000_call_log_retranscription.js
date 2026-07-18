/**
 * Re-transcription backfill markers on call_log (voice-corpus training).
 *
 * - transcription_pre_backfill: the ORIGINAL (legacy/undiarized) transcript,
 *   preserved before the diarized upgrade overwrites `transcription` — audit
 *   trail and rollback material, written once (COALESCE-guarded).
 * - retranscribed_at: exactly-one-attempt stamp for the hourly backfill
 *   (success or failure — dead recordings are never retried), and the
 *   corpus miner's recency signal for backfilled OLD calls, whose created_at
 *   sits far outside the miner's mining window.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.text('transcription_pre_backfill');
    t.timestamp('retranscribed_at');
    t.index('retranscribed_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.dropIndex('retranscribed_at');
    t.dropColumn('transcription_pre_backfill');
    t.dropColumn('retranscribed_at');
  });
};
