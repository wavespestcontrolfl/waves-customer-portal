/**
 * GSM-7 punctuation normalizer.
 *
 * A single typographic character (a curly apostrophe, an em dash, a real
 * ellipsis) forces the ENTIRE SMS body into UCS-2 encoding: 67 chars per
 * concatenated segment instead of 153. The identical text silently costs
 * 2x the segments, and long concatenated messages have failed to reach
 * handsets that still ACK delivery (2026-07 Sue Helgren: multi-segment
 * reminders "delivered" but never seen; single-segment texts arrived).
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
  // Bullets / ellipsis
  ['•', '-'], // bullet (list marker)
  ['…', '...'], // horizontal ellipsis
  // Invisible characters that add UCS-2 cost with zero visible content
  ['​', ''], // zero-width space
  ['‌', ''], // zero-width non-joiner
  ['‍', ''], // zero-width joiner
  ['⁠', ''], // word joiner
  ['﻿', ''], // BOM / zero-width no-break space
  ['­', ''], // soft hyphen
]);

// The Unicode space family (NBSP, en/em/thin/hair spaces, narrow NBSP,
// medium mathematical space, ideographic space) all normalize to a plain
// space. \u2000-\u200A is a deliberate range; nothing in REPLACEMENTS
// falls inside it.
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
  return body.replace(NORMALIZE_RE, (ch) => (ch in REPLACEMENTS ? REPLACEMENTS[ch] : ' '));
}

module.exports = {
  normalizeGsmPunctuation,
  // Exposed for tests
  _internals: { REPLACEMENTS, NORMALIZE_RE },
};
