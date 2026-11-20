'use strict';

/**
 * procurement/deal-email-text.js — the text rules both readers of the Monday SiteOne deals
 * bell share: its date patterns (siteone-deals-digest.js) and its AI read
 * (siteone-deal-end-date.js).
 *
 * Quoted reply history is dropped from its first marker line on ("From:", "-- Original
 * Message --", "On ... wrote:"): a "tomorrow" in an older quoted email is not tomorrow from
 * the reply's date. A numeric date is m/d, m/d/yy or m/d/yyyy, not part of a longer number or
 * path, and not a fraction of a unit ("1/2 gal").
 */

const QUOTED_HISTORY = [
  /^[ \t]*From:/im,
  /^[ \t>]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^[ \t>]*On\s[\s\S]{0,250}?\swrote:/im,
];

/** Drops quoted reply history: everything from its first marker line on. */
function stripQuotedHistory(text) {
  let end = text.length;
  for (const re of QUOTED_HISTORY) {
    const m = re.exec(text);
    if (m && m.index < end) end = m.index;
  }
  return text.slice(0, end);
}

// m/d, m/d/yy, m/d/yyyy. Not part of a longer number or path, and not a fraction of a unit ("1/2 gal").
// Read it with matchAll only: a shared /g regex must keep lastIndex 0.
const NUMERIC_DATE = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])(?!\s*(?:oz|lbs?|gal|gallons?|inch|in\b|"|%|cups?|pt|qt|tons?|acres?|ac\b))/gi;

module.exports = { stripQuotedHistory, NUMERIC_DATE };
