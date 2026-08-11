/**
 * GSM-7 punctuation normalizer.
 *
 * A single typographic character (a curly apostrophe, an em dash, a real
 * ellipsis) forces the ENTIRE SMS body into UCS-2 encoding: 67 chars per
 * concatenated segment instead of 153. The identical text silently costs
 * 2x the segments, and long concatenated messages have failed to reach
 * handsets that still ACK delivery (2026-07 incident: a customer's
 * multi-segment reminders were "delivered" but never seen, while every
 * single-segment text arrived).
 *
 * This module maps typographic punctuation to its plain GSM-7 equivalent.
 * It is deliberately conservative: only characters with an exact plain
 * substitute are touched. Emoji, accented letters, currency symbols, and
 * anything meaning-bearing pass through unchanged: emoji policy stays with
 * validate_no_customer_emoji, and accented names must not be mangled.
 *
 * Several mapped characters are invisible or visually identical to their
 * replacement, so every pair carries its Unicode name in a comment and the
 * matching regex is built from code points, never from eyeballing glyphs.
 */

// Exact-substitute pairs. Anything not listed here (and not in the Unicode
// space family, handled below) is left alone.
const REPLACEMENTS = Object.fromEntries([
  // Apostrophes / single quotes
  ['‘', "'"], // left single quote
  ['’', "'"], // right single quote (the common smart apostrophe)
  ['‚', "'"], // single low-9 quote
  ['‛', "'"], // single high-reversed-9 quote
  ['′', "'"], // prime
  ['ʼ', "'"], // modifier letter apostrophe
  ['`', "'"], // backtick (not in the GSM basic alphabet)
  ['´', "'"], // acute accent used as apostrophe
  // Double quotes
  ['“', '"'], // left double quote
  ['”', '"'], // right double quote
  ['„', '"'], // double low-9 quote
  ['‟', '"'], // double high-reversed-9 quote
  ['″', '"'], // double prime
  // Dashes
  ['‐', '-'], // hyphen
  ['‑', '-'], // non-breaking hyphen
  ['‒', '-'], // figure dash
  ['–', '-'], // en dash
  ['—', '-'], // em dash
  ['―', '-'], // horizontal bar
  ['−', '-'], // minus sign
  // Bullets
  ['•', '-'], // bullet (list marker)
  // Invisible characters that add UCS-2 cost with zero visible content.
  // Deliberately NOT stripped: ZWJ (U+200D) and ZWNJ (U+200C) — they are
  // join controls inside emoji sequences and complex scripts, so removing
  // them changes rendered content (a joined emoji splits into two), and
  // internal-briefing SMS legitimately carries emoji.
  ['​', ''], // zero-width space
  ['⁠', ''], // word joiner
  ['﻿', ''], // BOM / zero-width no-break space
  ['­', ''], // soft hyphen
]);

// The Unicode space family (NBSP, en/em/thin/hair spaces, narrow NBSP,
// medium mathematical space, ideographic space) all normalize to a plain
// space. \u2000-\u200A is a deliberate range; nothing in REPLACEMENTS
// falls inside it.
// The ellipsis is the one replacement that GROWS the body (1 char -> 3),
// so it lives outside REPLACEMENTS: that trade only pays when it flips the
// whole body to GSM-7. When a preserved non-GSM character (an accented
// name, an internal-alert emoji) keeps the body UCS-2 regardless, the
// single-char ellipsis is cheaper — expanding it would add code units and
// can add a segment at a 67-unit boundary.
const ELLIPSIS_RE = /\u2026/g;

// Twilio's hard outbound body cap, mirrored from sms-guard.js
// validateOutbound (body.length > 1600 -> 'body-too-long'). Expansion must
// never push a previously valid body over it.
const OUTBOUND_BODY_LIMIT = 1600;

const SPACE_CLASS = '\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000';

// One regex pass over everything this module touches.
const NORMALIZE_RE = new RegExp(
  `[${Object.keys(REPLACEMENTS).map((ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join('')}${SPACE_CLASS}]`,
  'g'
);

/**
 * Replace typographic punctuation with plain GSM-7 equivalents. Idempotent;
 * returns non-string / empty input unchanged.
 *
 * @param {string} body
 * @returns {string}
 */
function normalizeGsmPunctuation(body) {
  if (typeof body !== 'string' || body === '') return body;
  let out = body.replace(NORMALIZE_RE, (ch) => (ch in REPLACEMENTS ? REPLACEMENTS[ch] : ' '));
  if (ELLIPSIS_RE.test(out)) {
    ELLIPSIS_RE.lastIndex = 0;
    const expanded = out.replace(ELLIPSIS_RE, '...');
    // Lazy require avoids a cycle if segment-counter ever imports this
    // module; today it imports nothing.
    const { countSegments } = require('./segment-counter');
    const expandedMeta = countSegments(expanded);
    // Expansion must land on GSM-7 AND not cost segments: a body dense
    // with ellipses (70 fit in one UCS-2 segment) would expand to 210
    // periods = two GSM-7 segments, increasing the very cost and delivery
    // risk this normalizer exists to avoid.
    if (expanded.length <= OUTBOUND_BODY_LIMIT
      && expandedMeta.encoding === 'GSM_7'
      && expandedMeta.segmentCount <= countSegments(out).segmentCount) out = expanded;
  }
  return out;
}

/**
 * First character this module classifies as typographic/non-GSM punctuation
 * (including the ellipsis), or null. THE detection surface for lint layers
 * (comms-lint) — they must share this classification, never keep a parallel
 * character list that drifts from REPLACEMENTS.
 */
function findTypographicChar(text) {
  if (typeof text !== 'string' || text === '') return null;
  NORMALIZE_RE.lastIndex = 0;
  ELLIPSIS_RE.lastIndex = 0;
  const m = NORMALIZE_RE.exec(text) || ELLIPSIS_RE.exec(text);
  NORMALIZE_RE.lastIndex = 0;
  ELLIPSIS_RE.lastIndex = 0;
  return m ? m[0] : null;
}

module.exports = {
  normalizeGsmPunctuation,
  findTypographicChar,
  // Exposed for tests
  _internals: { REPLACEMENTS, NORMALIZE_RE },
};
