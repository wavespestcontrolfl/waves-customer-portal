/**
 * call-retranscription-backfill.js — voice-corpus training throughput
 * (owner 2026-07-11: no autonomy, maximize model training).
 *
 * The voice corpus only accepts DIARIZED Agent:/Caller: transcripts, which
 * call-recording-processor produces for NEW calls. Every consented inbound
 * call recorded before that shipped (or whose transcription failed) carries a
 * legacy Twilio-native transcript — or none — and is invisible to Loop 2.
 * The nightly miner counts them as `transcript_unlabeled`: a standing,
 * finite backlog flagged as the highest-ROI training gap back in June.
 *
 * Hourly, batched: re-transcribe those recordings through the SAME
 * `transcribeRecording` pipeline new calls use (gpt-4o-transcribe-diarize,
 * plausibility guard included), then upgrade call_log.transcription in place
 * so the miner picks the call up on its next run. The original transcript is
 * preserved in transcription_pre_backfill; retranscribed_at stamps exactly
 * one attempt per call (success OR failure — a broken recording is not worth
 * retrying every hour), and doubles as the miner's recency signal for these
 * old calls.
 *
 * Consent posture mirrors the miner exactly: inbound +
 * call_recording_consent_disclaimer_played === true only. Self-terminating:
 * zero candidates → no-op forever. Spend is bounded by the batch cap
 * (default 20 recordings/run).
 *
 * PII: never log transcript bodies or full phone numbers.
 */

const db = require('../models/db');
const logger = require('./logger');
const { hasAgentCallerLabels } = require('./sms-voice-corpus-miner');

const BATCH_LIMIT = Number(process.env.RETRANSCRIBE_BATCH_LIMIT) > 0
  ? Number(process.env.RETRANSCRIBE_BATCH_LIMIT)
  : 20;

/**
 * Candidates: consented inbound calls with a recording, never attempted, and
 * a transcript the corpus can't use (missing, or lacking either speaker
 * label). Newest first — recent calls reflect the current team's voice, and
 * the backlog drains toward history.
 */
function candidateQuery(dbi, { limit = BATCH_LIMIT } = {}) {
  return dbi('call_log')
    .where('direction', 'inbound')
    .where('call_recording_consent_disclaimer_played', true)
    .whereNotNull('recording_url')
    .whereNot('recording_url', '')
    .whereNull('retranscribed_at')
    .whereRaw("(transcription IS NULL OR transcription NOT ILIKE '%agent:%' OR transcription NOT ILIKE '%caller:%')")
    .select('id', 'recording_url', 'transcription', 'from_phone', 'to_phone', 'customer_id', 'created_at')
    .orderBy('created_at', 'desc')
    .limit(limit);
}

async function runRetranscriptionBackfill({ dbi = db, batchLimit = BATCH_LIMIT, transcribe } = {}) {
  const startedAt = Date.now();
  const calls = await candidateQuery(dbi, { limit: batchLimit });
  if (!calls.length) {
    logger.info('[retranscribe] no candidates — backlog drained');
    return { attempted: 0, upgraded: 0, unusable: 0, failed: 0, ms: Date.now() - startedAt };
  }

  const transcribeFn = transcribe
    || ((call) => require('./call-recording-processor').transcribeRecording(call.recording_url, { call }));

  const summary = { attempted: 0, upgraded: 0, unusable: 0, failed: 0 };
  for (const call of calls) {
    summary.attempted += 1;
    let outcome = 'failed';
    try {
      const result = await transcribeFn(call);
      const text = result?.transcription || null;
      if (text && hasAgentCallerLabels(text)) {
        // Guarded on retranscribed_at IS NULL: a concurrent run (or the live
        // processor finishing late) must not double-write. COALESCE keeps the
        // FIRST original if anything ever re-stamps.
        const changed = await dbi('call_log')
          .where({ id: call.id })
          .whereNull('retranscribed_at')
          .update({
            transcription_pre_backfill: dbi.raw('COALESCE(transcription_pre_backfill, transcription)'),
            transcription: text,
            retranscribed_at: dbi.fn.now(),
          });
        outcome = changed ? 'upgraded' : 'failed';
      } else {
        outcome = 'unusable'; // no speech, implausible, or still undiarized
      }
    } catch (err) {
      logger.warn(`[retranscribe] call ${call.id} failed: ${err.message}`);
      outcome = 'failed';
    }
    if (outcome !== 'upgraded') {
      // One attempt per call, success or not — stamp so the hourly cron never
      // burns spend retrying a dead recording. The original transcript stays.
      await dbi('call_log').where({ id: call.id }).whereNull('retranscribed_at').update({
        retranscribed_at: dbi.fn.now(),
      });
    }
    summary[outcome === 'upgraded' ? 'upgraded' : outcome] += 1;
  }

  logger.info(`[retranscribe] run complete: attempted=${summary.attempted} upgraded=${summary.upgraded} unusable=${summary.unusable} failed=${summary.failed} ms=${Date.now() - startedAt}`);
  return { ...summary, ms: Date.now() - startedAt };
}

module.exports = {
  BATCH_LIMIT,
  candidateQuery,
  runRetranscriptionBackfill,
};
