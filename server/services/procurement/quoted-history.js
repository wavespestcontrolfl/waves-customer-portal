'use strict';

/**
 * procurement/quoted-history.js — drops quoted reply history from an email's text: everything
 * from its first marker line on ("From:", "-- Original Message --", "On ... wrote:"). The Monday
 * SiteOne deals bell reads an offer's end date from the new part of an email only, by its date
 * patterns (siteone-deals-digest.js) and by its AI read (siteone-deal-end-date.js) alike: a
 * "tomorrow" in an older quoted email is not tomorrow from the reply's date.
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

module.exports = { stripQuotedHistory };
