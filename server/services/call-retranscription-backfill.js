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
 * `transcribeRecording` pipeline new calls use, apply the SAME
 * `isImplausibleTranscript` hallucination guard the live path applies, then
 * upgrade call_log.transcription in place so the miner picks the call up on
 * its next run. The original transcript is preserved in
 * transcription_pre_backfill.
 *
 * Attempt discipline:
 *   - Per-recording VERDICTS (no speech, implausible for the duration, still
 *     undiarized) stamp retranscribed_at on the first try — re-paying for the
 *     same audio can't change the audio.
 *   - INFRASTRUCTURE failures (provider 5xx/timeouts/credentials) increment
 *     retranscribe_attempts and retry on later runs, stamping permanently
 *     only after MAX_ATTEMPTS — an OpenAI outage must not burn the backlog.
 *
 * Candidates: inbound, consent disclaimer played, not wrong_number/spam,
 * at least 7 days old, AND in a processing state the live pipeline is
 * provably done with (processed / fenced-out extraction_failed) — this job
 * never contends with or mutates the live call state machine; the guarded
 * UPDATE re-checks still-undiarized so a live result is never clobbered.
 * Self-terminating: zero candidates → no-op. Spend bounded by the batch cap.
 *
 * PII: never log transcript bodies or full phone numbers.
 */

const db = require('../models/db');
const logger = require('./logger');
const { hasAgentCallerLabels } = require('./sms-voice-corpus-miner');

const BATCH_LIMIT = Number(process.env.RETRANSCRIBE_BATCH_LIMIT) > 0
  ? Number(process.env.RETRANSCRIBE_BATCH_LIMIT)
  : 20;
const MAX_ATTEMPTS = 3;
const UNDIARIZED_SQL = "(transcription IS NULL OR transcription NOT ILIKE '%agent:%' OR transcription NOT ILIKE '%caller:%')";

function candidateQuery(dbi, { limit = BATCH_LIMIT } = {}) {
  return dbi('call_log')
    .where('direction', 'inbound')
    .where('call_recording_consent_disclaimer_played', true)
    .whereNotNull('recording_url')
    .whereNot('recording_url', '')
    .whereNull('retranscribed_at')
    .where('retranscribe_attempts', '<', MAX_ATTEMPTS)
    // Past the live processor's LONGEST retry horizon (extraction_failed
    // retries are bounded at 7 days; the other retry statuses resolve within
    // hours), so nothing the live lane still owns is ever grabbed here and
    // parked as processed — a stuck-but-current call keeps its shot at the
    // normal extraction/lead/appointment path.
    .whereRaw("created_at < NOW() - INTERVAL '7 days'")
    .whereRaw(UNDIARIZED_SQL)
    // The miner drops wrong_number/spam — don't pay to transcribe them.
    // NULL outcome stays eligible (NOT IN is UNKNOWN on NULL).
    .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
    // ONLY states the live pipeline is provably done with (Codex r5):
    // 'processed' rows are skipped by processRecording and never re-swept;
    // 'extraction_failed' rows are past processAllPending's 7-day fence
    // given the age filter above. Everything else (NULL/pending/
    // no_transcription/stale processing) still BELONGS to the live sweep —
    // however old — so this job never touches it, and spam/voicemail are
    // excluded for free. no_transcription rows lose nothing: the sweep has
    // retried them hourly with this same transcriber since the pipeline
    // shipped; what is still untranscribed is unrescuable audio.
    .whereIn('processing_status', ['processed', 'extraction_failed'])
    .select('id', 'recording_url', 'recording_sid', 'twilio_call_sid', 'transcription', 'transcript_structured',
      'from_phone', 'to_phone', 'customer_id',
      'created_at', 'recording_duration_seconds', 'duration_seconds')
    .orderBy('created_at', 'desc')
    .limit(limit);
}

async function runRetranscriptionBackfill({ dbi = db, batchLimit = BATCH_LIMIT, transcribe, implausible } = {}) {
  const startedAt = Date.now();
  const calls = await candidateQuery(dbi, { limit: batchLimit });
  if (!calls.length) {
    logger.info('[retranscribe] no candidates — backlog drained');
    return { attempted: 0, upgraded: 0, unusable: 0, retried: 0, exhausted: 0, ms: Date.now() - startedAt };
  }

  const processor = () => require('./call-recording-processor');
  const transcribeFn = transcribe || ((call) => processor().transcribeRecording(call.recording_url, { call, quarantine: true }));
  const implausibleFn = implausible || ((text, seconds) => processor().isImplausibleTranscript(text, seconds));

  const summary = { attempted: 0, upgraded: 0, unusable: 0, retried: 0, exhausted: 0 };

  const stampVerdict = (id) => dbi('call_log').where({ id }).whereNull('retranscribed_at').update({
    retranscribed_at: dbi.fn.now(),
  });
  // Infrastructure failure: count the attempt, stamp permanently only once
  // MAX_ATTEMPTS is reached — a provider outage retries on later runs.
  const recordFailure = async (id) => {
    const [row] = await dbi('call_log')
      .where({ id })
      .whereNull('retranscribed_at')
      .update({ retranscribe_attempts: dbi.raw('COALESCE(retranscribe_attempts, 0) + 1') })
      .returning(['retranscribe_attempts']);
    const attempts = Number(row?.retranscribe_attempts) || 0;
    if (attempts >= MAX_ATTEMPTS) {
      await stampVerdict(id);
      return 'exhausted';
    }
    return 'retried';
  };

  for (const call of calls) {
    summary.attempted += 1;
    try {
      const result = await transcribeFn(call);
      // Heal legacy PAN-bearing artifacts IMMEDIATELY — the unusable/
      // retry verdict branches below stamp retranscribed_at (or leave the
      // row for another pass) without ever reaching the main update, which
      // would leave a raw card number stored permanently (Codex #2676
      // round-5 P1). Runs AFTER transcribeFn so the quarantine's recording
      // delete can't race the re-listen this job exists to perform.
      // Candidates are terminal-state rows the live pipeline is done with,
      // so the whereNull(retranscribed_at) guard is sufficient against
      // concurrent writers.
      try {
        const legacyText = require('../utils/pan-scrub').scrubPansDetailed(call.transcription ?? null);
        const legacyStructured = processor().scrubStructuredTranscript(call.transcript_structured ?? null);
        if (legacyText.count + legacyStructured.count > 0) {
          await dbi('call_log')
            .where({ id: call.id })
            .whereNull('retranscribed_at')
            .update({
              ...(legacyText.count > 0 ? { transcription: legacyText.text } : {}),
              ...(legacyStructured.count > 0 ? { transcript_structured: legacyStructured.json } : {}),
              updated_at: dbi.fn.now(),
            });
          if (legacyText.count > 0) call.transcription = legacyText.text;
          if (legacyStructured.count > 0) call.transcript_structured = legacyStructured.json;
          await processor().quarantineCardRecording(call, { source: 'retranscription_backfill_legacy' });
          call.recording_url = null;
        }
      } catch (healErr) {
        logger.error(`[retranscribe] legacy PAN heal failed for call ${call.id}: ${healErr.message}`);
      }
      const text = result?.transcription || null;
      if (!text || result?.provider === 'openai_unlabeled_fallback') {
        // No text, or raw unlabeled text because BOTH the labeling pass and
        // the Gemini fallback failed transiently — either way this says
        // nothing about the audio itself. Retryable, not a verdict.
        summary[await recordFailure(call.id)] += 1;
        continue;
      }
      const seconds = Number(call.recording_duration_seconds) || Number(call.duration_seconds) || null;
      if (!hasAgentCallerLabels(text) || implausibleFn(text, seconds)) {
        // A real per-recording verdict: the audio itself can't yield a usable
        // diarized transcript. One attempt, ever.
        await stampVerdict(call.id);
        summary.unusable += 1;
        continue;
      }
      // Guarded upgrade: retranscribed_at still NULL AND the transcript is
      // still undiarized — if the live processor (or a concurrent run) wrote
      // a diarized transcript meanwhile, leave it alone and just stamp.
      // PAN redaction guard (card-on-file spec Phase 0) — this backfill
      // writes fresh provider text outside the live pipeline's choke scrub,
      // and the LEGACY artifacts must be healed in the same touch: the
      // preserved original (round-1 P1) AND any stored transcript_structured
      // whose segments/contact-pass predate the guard (round-4 P1). Fresh
      // provider text arrives already masked with the detection carried in
      // result.metadata.pan_count, and transcribeRecording quarantined the
      // recording itself; the freshScrub here is belt-and-suspenders for
      // injected test transcribers.
      const panScrubModule = require('../utils/pan-scrub');
      const freshScrub = panScrubModule.scrubPansDetailed(text);
      const preservedScrub = panScrubModule.scrubPansDetailed(call.transcription ?? null);
      const structuredScrub = processor().scrubStructuredTranscript(call.transcript_structured ?? null);
      const providerPanCount = Number(result?.metadata?.pan_count || 0);
      const changed = await dbi('call_log')
        .where({ id: call.id })
        .whereNull('retranscribed_at')
        .whereRaw(UNDIARIZED_SQL)
        .update({
          // An already-populated pre_backfill value is kept as-is (first
          // stamp wins, matching the original COALESCE).
          transcription_pre_backfill: dbi.raw('COALESCE(transcription_pre_backfill, ?)', [
            preservedScrub.text ?? null,
          ]),
          ...(structuredScrub.count > 0 ? { transcript_structured: structuredScrub.json } : {}),
          transcription: freshScrub.text,
          retranscribed_at: dbi.fn.now(),
          // processing_status is deliberately untouched: candidates are
          // restricted to states the live pipeline is done with, so there is
          // nothing to park and no live state machine to disturb (Codex r5).
        });
      if (changed) {
        summary.upgraded += 1;
        // Card detected in ANY artifact — the fresh text (belt: normally
        // pre-masked with the count in provider metadata), the preserved
        // legacy transcript, or the stored structured JSON — quarantine the
        // recording. transcribeRecording already quarantined for provider
        // detections; the notify inside is once-per-call idempotent, so this
        // re-run only heals the legacy-artifact cases.
        if (freshScrub.count + preservedScrub.count + structuredScrub.count + providerPanCount > 0) {
          try {
            await processor().quarantineCardRecording(call, { source: 'retranscription_backfill' });
          } catch (qErr) {
            logger.error(`[retranscribe] PAN quarantine failed for call ${call.id}: ${qErr.message}`);
          }
        }
      } else {
        await stampVerdict(call.id);
        summary.unusable += 1; // someone else already diarized it — done either way
      }
    } catch (err) {
      logger.warn(`[retranscribe] call ${call.id} failed: ${err.message}`);
      summary[await recordFailure(call.id)] += 1;
    }
  }

  logger.info(`[retranscribe] run complete: attempted=${summary.attempted} upgraded=${summary.upgraded} unusable=${summary.unusable} retried=${summary.retried} exhausted=${summary.exhausted} ms=${Date.now() - startedAt}`);
  return { ...summary, ms: Date.now() - startedAt };
}

module.exports = {
  BATCH_LIMIT,
  MAX_ATTEMPTS,
  candidateQuery,
  runRetranscriptionBackfill,
};
