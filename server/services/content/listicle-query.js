/**
 * listicle-query.js — the single definition of "list-shaped query".
 *
 * Shared by the brief-builder's listicle overlay (which formats a
 * supporting-blog brief as a citable listicle) and the GSC opportunity
 * miner's listicle_family bucket (which surfaces list-shaped demand).
 * Two independent copies of this grammar WILL diverge — a query the miner
 * surfaces that the overlay then rejects produces a plain post where a
 * listicle was promised, silently. Keep every consumer on this module.
 */

// Query shapes that map naturally to an enumerable list: a leading count
// ("10 natural mosquito repellents") or an enumerable-noun keyword. Kept
// narrow on purpose — a miss just produces a normal supporting-blog, and a
// borderline match still yields a valid post, just list-formatted. A leading
// digit followed by a time/cadence unit ("24 hour pest control", "7 day
// treatment plan") is service phrasing, not an item count — excluded.
const LISTICLE_TIME_UNIT_RE = /^(hour|hr|day|week|month|year|minute|min|am|pm)s?\b/i;
// Hyphen accepted between the number and the next token: '7-day' and
// '24-hour' are cadence phrasings that must ENTER the guard, not skirt it
// into the noun fallback.
const LISTICLE_LEADING_COUNT_RE = /^\s*\d{1,2}[\s-]+(\S+)/;
const LISTICLE_NOUN_RE = /\b(signs?|symptoms|ways|tips|ideas|mistakes|myths|types|kinds|reasons|steps|plants|checklist)\b/i;
// Vendor/roundup intent ("10 best pest control companies", "top exterminators")
// must never receive the treatment: the overlay's voice notes forbid ranking
// companies, so the brief would be self-contradictory — leave those SERPs to
// the existing buyer-guide/comparison handling. Conservative by design:
// excluding e.g. "best plants for shade" only costs the list formatting,
// never the post.
const LISTICLE_VENDOR_RE = /\b(best|top|cheapest|company|companies|providers?|services?|exterminators?|contractors?|businesses?|firms?|brands?|reviews?|vs)\b/i;

function isListicleQuery(query) {
  const q = String(query || '').trim();
  if (!q) return false;
  if (LISTICLE_VENDOR_RE.test(q)) return false;
  const count = q.match(LISTICLE_LEADING_COUNT_RE);
  if (count) {
    // A time-unit or numeric second token ("7 day …", "24 7 pest control" —
    // GSC strips the slash from 24/7) marks the leading number as CADENCE,
    // and that verdict is final: falling through to the noun matcher would
    // let "7 day termite treatment checklist" mandate a 7-item listicle
    // for a cadence query.
    if (LISTICLE_TIME_UNIT_RE.test(count[1]) || /^\d/.test(count[1])) return false;
    return true;
  }
  return LISTICLE_NOUN_RE.test(q);
}

module.exports = {
  isListicleQuery,
  LISTICLE_TIME_UNIT_RE,
  LISTICLE_LEADING_COUNT_RE,
  LISTICLE_NOUN_RE,
  LISTICLE_VENDOR_RE,
};
