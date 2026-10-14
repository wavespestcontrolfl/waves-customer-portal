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
 *  - social post photo: the hosted photo's URL (an unguessable key minted per
 *    upload, so it names exactly one image) plus the caption the model was
 *    given; photo-privacy-shadow.js builds the state the same way.
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

const SOCIAL_CAPTION_CHARS = 2000;
const SOCIAL_CAPTION_ORDER = ['facebook', 'instagram', 'gbp'];

// The one caption a photo question is given: the first platform's published
// text, in a fixed order. `captions` is the post's published_content (an object
// or its JSON text). Empty when there is none.
function socialPostCaption(captions) {
  let map = captions;
  if (typeof map === 'string') {
    try { map = JSON.parse(map); } catch { map = null; }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return '';
  for (const platform of SOCIAL_CAPTION_ORDER) {
    const text = typeof map[platform] === 'string' ? map[platform].trim() : '';
    if (text) return text.slice(0, SOCIAL_CAPTION_CHARS);
  }
  return '';
}

function socialPostSubjectHash({ imageUrl, captions }) {
  return crypto.createHash('sha256').update(JSON.stringify([imageUrl || null, socialPostCaption(captions)])).digest('hex');
}

module.exports = { callSubjectHash, callTranscriptSpan, smsSubjectHash, smsCustomerText, socialPostCaption, socialPostSubjectHash };
