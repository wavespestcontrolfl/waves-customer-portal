/**
 * The digest of exactly the subject text a call_judge answer was given: the
 * transcript cut to CALL_TRANSCRIPT_CHARS (call-self-audit.js builds Jev's
 * state the same way). Stored with each call decision (decision_reviews.
 * subject_hash) and recomputed by the review route from the live transcript,
 * so a call force-reprocessed after Jev answered is shown as changed and
 * cannot be labeled against the old answer. A hash only, never text.
 */
const crypto = require('crypto');
const { CALL_TRANSCRIPT_CHARS } = require('./packages');

function callTranscriptSpan(transcription) {
  return String(transcription || '').slice(0, CALL_TRANSCRIPT_CHARS);
}

function callSubjectHash(transcription) {
  return crypto.createHash('sha256').update(callTranscriptSpan(transcription)).digest('hex');
}

module.exports = { callSubjectHash, callTranscriptSpan };
