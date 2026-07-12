/**
 * PAN (card number) scrubber for call transcripts.
 *
 * Phase 0 of docs/card-on-file-booking-build-spec.md: with card-on-file as
 * the booking gate, customers WILL sometimes blurt a card number on a
 * recorded line despite the text-the-link policy. A PAN must never persist
 * (call_log.transcription / transcript_structured / message mirrors) and
 * must never reach an LLM prompt (extraction, CSR coach, corpus miner, KB).
 * This module makes a blurted card number a non-event: Luhn-validated
 * 13–19-digit runs are masked to their last4.
 *
 * Deliberately dependency-free (no logger, no db) so it can run inside the
 * transcription hot path and be required from webhook routes without cycles.
 *
 * Two candidate shapes are scrubbed:
 *  - NUMERIC runs: 13–19 digits with optional single space/dash separators
 *    ("4242424242424242", "4242 4242 4242 4242", "4242-4242…"). Runs longer
 *    than 19 contiguous digits are not PANs and are left alone.
 *  - SPOKEN-DIGIT runs: 13–19 consecutive digit WORDS ("four two four two
 *    …", "oh" accepted as zero), the shape diarized transcripts produce when
 *    a caller reads a card aloud.
 *
 * Both gate on Luhn before masking, so phone numbers (10–11 digits — below
 * the window) and arbitrary reference numbers (Luhn-invalid 90% of the
 * time) pass through untouched. The mask keeps last4 ("[card ending 4242]")
 * — enough for the office to reconcile with Stripe, never enough to charge.
 * CVVs are NOT detected here (3–4 digits is unmatchable noise); the policy
 * fix for CVV is upstream — never accept a card read aloud at all.
 */

function luhnValid(digits) {
  if (typeof digits !== 'string' || !/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Numeric candidate: 13–19 digits, single optional space/dash between them.
// Lookarounds keep us from matching a 13–19 window carved out of a LONGER
// contiguous digit run (>19 digits is not a PAN).
const NUMERIC_PAN_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

const DIGIT_WORDS = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
// Spoken-digit candidate: 13–19 digit words separated by spaces/commas.
const WORD_RUN_RE = new RegExp(
  `\\b(?:(?:${Object.keys(DIGIT_WORDS).join('|')})[ ,]+){12,18}(?:${Object.keys(DIGIT_WORDS).join('|')})\\b`,
  'gi'
);

function maskFor(digits) {
  return `[card ending ${digits.slice(-4)}]`;
}

/**
 * Scrub PANs from a string. Returns { text, count }. Non-strings pass
 * through untouched with count 0 (never throw in the transcription path).
 */
function scrubPansDetailed(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, count: 0 };
  }
  let count = 0;
  let out = text.replace(NUMERIC_PAN_RE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (!luhnValid(digits)) return match;
    count += 1;
    return maskFor(digits);
  });
  out = out.replace(WORD_RUN_RE, (match) => {
    const digits = match
      .toLowerCase()
      .split(/[ ,]+/)
      .map((w) => DIGIT_WORDS[w] ?? '')
      .join('');
    if (!luhnValid(digits)) return match;
    count += 1;
    return maskFor(digits);
  });
  return { text: out, count };
}

/** Convenience: scrubbed string only. */
function scrubPans(text) {
  return scrubPansDetailed(text).text;
}

module.exports = { luhnValid, scrubPans, scrubPansDetailed };
