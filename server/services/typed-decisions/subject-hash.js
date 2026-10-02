/**
 * The digest of exactly the subject text a decision was given, stored with
 * each row (decision_reviews.subject_hash) and recomputed by the review route
 * from the live data, so a subject that changed after Jev answered is shown as
 * changed and cannot be labeled against the old answer. A hash only, never text.
 *  - call: the transcript cut to CALL_TRANSCRIPT_CHARS (call-self-audit.js
 *    builds Jev's state the same way); a force-reprocess rewrites it.
 *  - text: the previous Waves text plus the customer's trimmed text, the
 *    state sms-shadow.js gives Jev; the previous-text lookup can resolve
 *    differently later (a send's status changes).
 */
const crypto = require('crypto');
const { CALL_TRANSCRIPT_CHARS } = require('./packages');

function callTranscriptSpan(transcription) {
  return String(transcription || '').slice(0, CALL_TRANSCRIPT_CHARS);
}

function callSubjectHash(transcription) {
  return crypto.createHash('sha256').update(callTranscriptSpan(transcription)).digest('hex');
}

const SMS_TEXT_CHARS = 2000;

function smsCustomerText(body) {
  return (typeof body === 'string' ? body.trim() : '').slice(0, SMS_TEXT_CHARS);
}

function smsSubjectHash({ previous, body }) {
  return crypto.createHash('sha256').update(JSON.stringify([previous || null, smsCustomerText(body)])).digest('hex');
}

module.exports = { callSubjectHash, callTranscriptSpan, smsSubjectHash, smsCustomerText };
