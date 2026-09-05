// Likely-reviewer suggestions for unlinked Google reviews.
//
// The tracked direct-link redirect stamps review_requests.redirected_at per
// customer BEFORE 302ing to the Google review form, but Google never reports
// which account submitted a review — so when a review syncs in under a display
// name that doesn't match any customer ("SunshineGal88"), the office has to
// play detective. This module does the detective work: customers whose tracked
// click landed near the review's timestamp, ranked by proximity.
//
// SUGGESTION ONLY. A click near a review is evidence, not proof (two customers
// can click the same hour; a clicker may never submit). Nothing here writes —
// no auto-mark, no auto-link. The office confirms via the existing manual
// match flow, which is what flips has_left_google_review.

const db = require('../models/db');
const logger = require('./logger');
const { PROVIDER_SENTINEL_TOKEN_RE } = require('./review-reply/grounding');

// A reviewer almost always taps the link shortly before the review posts, but
// people do come back to a text hours later — 72h covers the long tail without
// flooding the list. The small after-window absorbs clock skew and the
// "clicked again to check my review posted" pattern.
const WINDOW_BEFORE_HOURS = 72;
const WINDOW_AFTER_HOURS = 6;
const DEFAULT_LIMIT = 5;
// Raw scan bound before per-customer dedupe — the window rarely holds more
// than a handful of clicks at current volume.
const SCAN_LIMIT = 200;

/**
 * A name for matching: lowercased, diacritics stripped, punctuation trimmed,
 * whitespace collapsed ("Muñoz-Pérez" → "munoz-perez", "De La Cruz" →
 * "de la cruz", "O’Connor" / "O'Connor" / "OConnor" → "oconnor"). '' when
 * nothing usable remains. Digits STAY: a handle-suffixed token ("Smith2")
 * is not the surname Smith, and dropping the digit manufactured one (GH
 * codex r6 P1). Apostrophes go in EVERY form (ASCII ', typographic
 * ’ ‘, modifier ʼ): Google's display name and the customer record rarely
 * agree on one, and keeping only the ASCII form let "O’Connor" match a
 * customer stored "OConnor" while missing one stored "O'Connor" — two such
 * customers must be two surname matches, not one (GH codex r4 P1). Hyphens
 * stay: a hyphen joins two surnames, whose suffix is a different surname —
 * and every dash form (U+2010–2015, U+2212) IS that hyphen, so "Smith‑Jones"
 * with a typographic hyphen matches a record stored "Smith-Jones", not one
 * stored "SmithJones" (GH codex r8 P1).
 * A letter NFD cannot fold to a-z (ß ø ł æ …) FAILS CLOSED to '': deleting
 * it manufactured a surname too ("Groß" → "gro"), and no transliteration
 * can be trusted to agree with the record ("Gross"? "Groß"?) — such a name
 * offers no surname evidence (GH codex r7 P1).
 */
function normalizeName(value) {
  const folded = String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase();
  if (/\p{L}/u.test(folded.replace(/[a-z]/g, ''))) return '';
  return folded
    .replace(/[^a-z0-9\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every COMPLETE last name a Google display name could carry — its
 * whole-word suffixes, normalized ("Maria De La Cruz" → "de la cruz",
 * "la cruz", "cruz", and the whole name). A customer matches when their
 * normalized last_name is one of these — never a bare final token, which
 * would let a customer stored as "Cruz" outrank one stored as "De La Cruz"
 * (GH codex r1 P1). A one-token display name ("SunshineGal88") offers no
 * surname and returns []. Trailing generational / professional suffixes
 * are dropped first: "John Smith Jr." offers "smith", never "jr" — a
 * customer stored "Jr" must not be the sole surname match (GH codex r8 P1);
 * generational numerals run through X, so "John Smith VI" offers "smith",
 * never "vi" (GH codex r9 P1) — but a numeral is a suffix only behind at
 * least two name tokens: "Alex Vi" is a person surnamed Vi (GH codex #3875
 * r1 P2); the set starts at I ("John Smith I"; GH codex #3875 r5 P2).
 * A comma fixes the order (GH codex r9 P1): "Smith, John" is last-name-
 * first, so the surname is the part BEFORE the comma — the WHOLE head and
 * only that ("De La Cruz, Maria" offers "de la cruz", never "cruz": the
 * comma made the surname boundary explicit; GH codex #3875 r2 P1), a
 * one-token head ("Smith") included. "John Smith, Jr." is a comma that only
 * sets off a suffix (nothing but suffixes after it) and reads in normal
 * order. A tail
 * that normalizeName fails closed on ("Smith, Søren") is still a given
 * name, not a suffix — the head stays the surname (GH codex #3875 r1 P2).
 * A display name made only of provider sentinel tokens ("A Google User",
 * "Anonymous") names nobody and offers no surname — "user" must never be
 * a surname match (GH codex #3875 r2 P1).
 */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'md', 'dds', 'dvm', 'phd', 'esq', 'cpa']);
const NUMERAL_SUFFIXES = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']);

// Normalized name tokens with the trailing suffixes dropped. `preceding` =
// name tokens that stand before this segment ("John Smith, III": the tail
// "iii" is a numeral suffix because two name tokens precede the comma;
// GH codex #3875 r3 P2).
function nameTokens(value, preceding = 0) {
  const tokens = normalizeName(value).split(' ').filter(Boolean);
  const isSuffix = (t, n) => NAME_SUFFIXES.has(t) || (NUMERAL_SUFFIXES.has(t) && preceding + n >= 3);
  while (tokens.length && isSuffix(tokens[tokens.length - 1], tokens.length)) tokens.pop();
  return tokens;
}

// Every whole-word suffix of the tokens, longest first; [] below minTokens.
const wholeWordSuffixes = (tokens, minTokens) => (tokens.length < minTokens
  ? []
  : tokens.map((_, i) => tokens.slice(i).join(' ')).filter((s) => s.length >= 2));

function reviewerSurnames(reviewerName) {
  const raw = String(reviewerName || '');
  const words = normalizeName(raw).split(' ').filter(Boolean);
  if (words.length && words.every((w) => PROVIDER_SENTINEL_TOKEN_RE.test(w))) return [];
  const comma = raw.indexOf(',');
  if (comma < 0) return wholeWordSuffixes(nameTokens(raw), 2);
  const head = nameTokens(raw.slice(0, comma));
  const tailRaw = raw.slice(comma + 1);
  // A tail with letters is a given name (even one normalizeName fails
  // closed on); only a suffix-only or empty tail leaves normal order.
  const suffixOnlyTail = !nameTokens(tailRaw, head.length).length && !(normalizeName(tailRaw) === '' && /\p{L}/u.test(tailRaw));
  if (suffixOnlyTail) return wholeWordSuffixes(head, 2);
  // Last-name-first: the whole head IS the surname (a one-token head included).
  return wholeWordSuffixes(head, 1).slice(0, 1);
}

/**
 * Human label for a click-to-review offset, e.g. "23m before" / "3h 10m after".
 * Positive offsetMs = the click preceded the review.
 */
function describeClickOffset(offsetMs) {
  const abs = Math.abs(offsetMs);
  const totalMinutes = Math.round(abs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  let span;
  if (days > 0) span = `${days}d${hours ? ` ${hours}h` : ''}`;
  else if (hours > 0) span = `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  else span = `${minutes}m`;
  return `${span} ${offsetMs >= 0 ? 'before' : 'after'}`;
}

/**
 * Find customers whose tracked review-link click landed near a Google
 * review's timestamp — candidates for who actually left it.
 *
 * @param {{review_created_at?: string|Date, location_id?: string}} review
 * @param {{conn?: object, limit?: number}} [options]
 * @returns {Promise<Array<{
 *   customerId: string, firstName: string|null, lastName: string|null,
 *   phone: string|null, email: string|null, addressLine1: string|null,
 *   addressLine2: string|null, city: string|null, state: string|null,
 *   zip: string|null, clickedAt: string, clickOffsetMs: number,
 *   clickOffsetLabel: string, clickedBeforeReview: boolean,
 *   locationMatch: boolean|null, locationConflict: boolean, alreadyFlagged: boolean,
 *   nameMatch: boolean
 * }>>} surname matches first, then nearest-click-first; [] on missing/invalid review timestamp or any
 * query error (suggestions are best-effort and must never break a caller).
 */
async function findLikelyReviewers(review, { conn = db, limit = DEFAULT_LIMIT, _meta = null } = {}) {
  // A missing or unparseable timestamp yields no candidates (`|| NaN`: a
  // null would otherwise parse as the epoch).
  const reviewAt = new Date(review?.review_created_at || NaN);
  if (Number.isNaN(reviewAt.getTime())) return [];
  const surnames = reviewerSurnames(review?.reviewer_name);

  try {
    const windowStart = new Date(reviewAt.getTime() - WINDOW_BEFORE_HOURS * 3600 * 1000);
    const windowEnd = new Date(reviewAt.getTime() + WINDOW_AFTER_HOURS * 3600 * 1000);

    const reviewLocationId = review?.location_id || null;
    // Archived customers (customers.deleted_at) STAY in the scan: the
    // archive path leaves their review_requests rows, and a click is a
    // click — an archived same-surname clicker is ambiguity the surname
    // rung must count (GH codex r6 P1). They are dropped from the
    // SUGGESTION list and never eligible for an auto-link (customerActive).
    let query = conn('review_requests as rr')
      .join('customers as c', 'rr.customer_id', 'c.id')
      .whereNotNull('rr.redirected_at')
      // Only server-observed clicks: the tracked redirect (review-gate)
      // stamps google_review_clicked when the browser actually follows the
      // link. The legacy promoter path stamps redirected_at OPTIMISTICALLY
      // before the client ever navigates (review-request.js submitRating) —
      // those rows are not evidence anyone reached the Google form (codex
      // #3264 r2).
      .where('rr.google_review_clicked', true)
      // EITHER observed click may qualify: redirected_at is the immutable
      // first-click claim, last_redirected_at the latest server-observed
      // tap (GH codex #3483 r1/r2). A row enters the window when either
      // timestamp lands in it — a pre-review first click must survive a
      // post-review revisit, and a fresh re-tap must revive a stale first
      // click. The JS pass below picks the best-qualifying timestamp.
      .whereRaw(
        '((rr.redirected_at >= ? AND rr.redirected_at <= ?) OR (rr.last_redirected_at >= ? AND rr.last_redirected_at <= ?))',
        [windowStart, windowEnd, windowStart, windowEnd],
      );
    // A click 302s to ONE location's review form — a click for a different
    // GBP than the review's is anti-evidence, not a weaker match; timestamp
    // proximity must not let it outrank the real clicker (codex #3264 r2).
    // Location-less clicks (pre-stamping legacy rows) stay in, annotated null.
    if (reviewLocationId) {
      // Either PAIRED location may admit the row (first-click location rides
      // google_location, latest-click location rides last_google_location —
      // GH codex #3483 r4); the JS pass gates each timestamp against its own
      // recorded location.
      // An UNSTAMPED latest tap admits the row too: it could have landed
      // on this location's form, and when the first pair is stamped for
      // another location nothing else would list it — a customer who
      // tapped moments before the review must count against every rung
      // (GH codex r7/r8 P1). The JS pair loop still skips the elsewhere
      // pair and keeps the unlocated one, annotated null.
      query = query.where(function locationFilter() {
        this.whereNull('rr.google_location')
          .orWhereNull('rr.last_google_location')
          .orWhere('rr.google_location', reviewLocationId)
          .orWhere('rr.last_google_location', reviewLocationId);
      });
    }
    const clicks = await query
      .orderByRaw('COALESCE(rr.last_redirected_at, rr.redirected_at) desc')
      .limit(SCAN_LIMIT)
      .select(
        'rr.customer_id',
        'rr.redirected_at',
        'rr.last_redirected_at',
        'rr.last_google_location',
        'rr.google_review_clicked',
        'rr.google_location',
        'c.first_name',
        'c.last_name',
        'c.phone',
        'c.email',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        'c.has_left_google_review',
        'c.active',
        'c.deleted_at',
      );
    if (!clicks.length) return [];
    const archived = new Set(clicks.filter((r) => r.deleted_at).map((r) => r.customer_id));

    // A customer already linked to a synced review is attributed — their click
    // explains their OWN review, not this one. Excluded rather than annotated
    // so the list only holds open questions. No inner catch: if this lookup
    // fails, suggestions without the exclusion could steer the office toward
    // a wrong attribution, so the outer catch returns [] instead (codex #3264
    // r1 P2). Both callers hold a google_reviews row, so the table exists.
    const ids = [...new Set(clicks.map((r) => r.customer_id))];
    const linkedRows = await conn('google_reviews')
      .whereIn('customer_id', ids)
      .where('reviewer_name', '!=', '_stats')
      .select('customer_id');
    const linked = new Set(linkedRows.map((r) => r.customer_id));

    // One entry per customer, nearest click wins. The clicked/location
    // filters repeat JS-side so behavior holds even where the SQL layer is
    // mocked (test harnesses ignore where-clauses — #3235 r6 lesson).
    // Preference order: a click BEFORE the review always beats one after it
    // (a post-review revisit must not mask the qualifying earlier tap — GH
    // codex #3483 r2 P2); among equals, nearest wins.
    const betterClick = (a, b) => {
      if (!b) return true;
      const aBefore = a.clickOffsetMs >= 0;
      const bBefore = b.clickOffsetMs >= 0;
      if (aBefore !== bBefore) return aBefore;
      return Math.abs(a.clickOffsetMs) < Math.abs(b.clickOffsetMs);
    };
    const byCustomer = new Map();
    // Customers with a pair STAMPED for a different location. That pair is
    // skipped below, but its existence is anti-evidence the surname rung
    // must see: a newer post-migration tap at another location must not
    // leave an older, untrusted first-click pair looking clean (GH codex r1
    // P1).
    const conflicting = new Set();
    for (const row of clicks) {
      if (row.google_review_clicked !== true) continue;
      // BOTH observed timestamps are candidate clicks, each judged ONLY
      // against the location recorded WITH it (GH codex #3483 r4): the
      // first click pairs with google_location (frozen at first click), the
      // latest with last_google_location. A legacy latest-click without a
      // paired location stays annotated null, never borrowed.
      // Pair TRUST (GH codex #3483 r5/r6): ONLY the latest pair is trusted
      // for auto-linking — it is stamped atomically at the successful
      // redirect, so timestamp and location were provably observed
      // together. First-click pairs are NEVER trusted: legacy /go overwrote
      // google_location on every revisit while redirected_at stayed at the
      // first click, and history can make a corrupted pair look
      // corroborated. Trust gates AUTO-LINK confidence only — suggestions
      // still list both pairs. Latest pair FIRST so a same-timestamp row
      // (the common single-click case) keeps the trusted candidate.
      const pairs = [
        { ts: row.last_redirected_at, loc: row.last_google_location, trusted: Boolean(row.last_google_location) },
        { ts: row.redirected_at, loc: row.google_location, trusted: false },
      ];
      const seenTs = new Set();
      for (const { ts, loc, trusted } of pairs) {
        if (!ts || seenTs.has(String(ts))) continue;
        seenTs.add(String(ts));
        if (reviewLocationId && loc && loc !== reviewLocationId) {
          conflicting.add(row.customer_id);
          continue;
        }
        const clickedAt = new Date(ts);
        if (Number.isNaN(clickedAt.getTime())) continue;
        // The OR window admits the ROW when either timestamp qualifies —
        // this clamp keeps the other, out-of-window timestamp from being
        // picked as the click (also holds under mocked SQL layers).
        if (clickedAt < windowStart || clickedAt > windowEnd) continue;
        const clickOffsetMs = reviewAt.getTime() - clickedAt.getTime();
        const candidate = { row, clickedAt, clickOffsetMs, pairLoc: loc, pairTrusted: trusted };
        if (betterClick(candidate, byCustomer.get(row.customer_id))) {
          byCustomer.set(row.customer_id, candidate);
        }
      }
    }

    const toCandidate = ({ row, clickedAt, clickOffsetMs, pairLoc, pairTrusted }) => ({
        customerId: row.customer_id,
        firstName: row.first_name || null,
        lastName: row.last_name || null,
        phone: row.phone || null,
        email: row.email || null,
        addressLine1: row.address_line1 || null,
        addressLine2: row.address_line2 || null,
        city: row.city || null,
        state: row.state || null,
        zip: row.zip || null,
        clickedAt: clickedAt.toISOString(),
        clickOffsetMs,
        clickOffsetLabel: describeClickOffset(clickOffsetMs),
        clickedBeforeReview: clickOffsetMs >= 0,
        // The location recorded WITH the chosen timestamp (GH codex r4);
        // null when that click predates location stamping.
        locationMatch: pairLoc && review?.location_id
          ? pairLoc === review.location_id
          : null,
        alreadyFlagged: row.has_left_google_review === true,
        // Whether this timestamp/location pair was recorded together
        // post-migration (or corroborated) — see the trust comment above.
        pairTrusted: pairTrusted === true,
        // STRICT true only (GH codex r8): a legacy NULL active must not
        // auto-link — the confirmation UI's candidate search requires
        // active=true, so a null-active link would be unconfirmable. An
        // archived customer is likewise unconfirmable (GH codex r6 P1).
        customerActive: row.active === true && !row.deleted_at,
        // Another of this customer's pairs is stamped for a DIFFERENT
        // location — see `conflicting` above.
        locationConflict: conflicting.has(row.customer_id),
        // The reviewer's display-name surname equals this customer's
        // COMPLETE last name (owner ruling 2026-09-03: the matcher weighs
        // the last name; GH codex r1 P1: whole surname, not the final token).
        nameMatch: surnames.includes(normalizeName(row.last_name)),
      });
    const all = [...byCustomer.values()].map(toCandidate);
    // Auto-link metadata, all of it read BEFORE the linked-customer
    // exclusion below: the confident matcher must see every competing
    // click in the window — a customer the suggestion list hides as
    // already-attributed can still review a DIFFERENT location's profile,
    // so their click is competing evidence, not noise (pre-push P1) — and
    // its proximity rung needs each competing click's offset, not just the
    // count.
    if (_meta) {
      _meta.distinctClickers = byCustomer.size;
      // A scan that filled SCAN_LIMIT may have truncated an older click out
      // of the window — sole-clicker can't be asserted over a partial read.
      _meta.scanTruncated = clicks.length >= SCAN_LIMIT;
      _meta.allCandidates = all;
      // The location filter above drops a clicker whose EVERY pair is
      // stamped for another GBP, and the pair loop skips an elsewhere pair
      // whose row was admitted by an unstamped or out-of-window first pair
      // (GH codex r2 P1) — right for suggestions and for the
      // location-gated rungs, but the surname rung must know that a second
      // same-surname customer tapped ANY location's link in the window
      // (pre-push r4 P1): two "Northgate" clickers = a human decides, no
      // matter which form each landed on. The matched customer's OWN
      // other-location rows count too — a second review_requests row
      // stamped elsewhere is the "any pair" conflict the main scan cannot
      // see (pre-push r5 P1). Auto-link path only.
      _meta.surnameClickerElsewhere = await surnameClickerElsewhere({
        conn, enabled: _meta.surnameRung, reviewLocationId, windowStart, windowEnd, surnames,
      });
    }

    // A customer already linked to a synced review is attributed — excluded
    // from the SUGGESTION list so it only holds open questions (codex #3264);
    // so is an archived one, who cannot be confirmed. Surname matches lead;
    // within a tier the nearest click wins.
    return all
      .filter((c) => !linked.has(c.customerId) && !archived.has(c.customerId))
      .sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || Math.abs(a.clickOffsetMs) - Math.abs(b.clickOffsetMs))
      .slice(0, Math.max(1, limit));
  } catch (err) {
    // ID-only logging (AGENTS.md) — no names in plaintext logs.
    logger.warn(`[review-click-correlation] likely-reviewer lookup failed: ${err.message}`);
    return [];
  }
}

/**
 * Whether any customer with the reviewer's surname holds a review-request
 * row with a pair — first OR latest, each judged with its own timestamp —
 * clicked in the window and stamped for a different location. The main
 * scan cannot count such a pair when the row's other pair is stamped
 * elsewhere too, is unstamped, or falls outside the window (pre-push r4/r5
 * P1, GH codex r2 P1: a legacy row with a NULL first location and a newer
 * tap stamped elsewhere). A competing customer is ambiguity; the matched
 * customer's own row is a conflicting pair. True on a truncated scan (the
 * window can't be proven clean). The pair predicate repeats JS-side, as in
 * the main scan. Archived customers count (GH codex r6 P1), as in the main
 * scan. Unstamped latest taps are the MAIN scan's job — its location
 * filter admits them for every rung (GH codex r7/r8 P1). Runs only when
 * the surname rung can act (`enabled` = GATE_REVIEW_CLICK_AUTOLINK_SURNAME
 * via `_meta.surnameRung`) for a located review with a surname to test —
 * dark, the scan would be a wasted query; false otherwise.
 */
async function surnameClickerElsewhere({ conn, enabled, reviewLocationId, windowStart, windowEnd, surnames }) {
  if (!enabled || !reviewLocationId || !surnames.length) return false;
  const rows = await conn('review_requests as rr')
    .join('customers as c', 'rr.customer_id', 'c.id')
    .whereNotNull('rr.redirected_at')
    .where('rr.google_review_clicked', true)
    .whereRaw(
      '((rr.google_location IS NOT NULL AND rr.google_location != ? AND rr.redirected_at >= ? AND rr.redirected_at <= ?) OR (rr.last_google_location IS NOT NULL AND rr.last_google_location != ? AND rr.last_redirected_at >= ? AND rr.last_redirected_at <= ?))',
      [reviewLocationId, windowStart, windowEnd, reviewLocationId, windowStart, windowEnd],
    )
    .limit(SCAN_LIMIT)
    .select('rr.customer_id', 'rr.redirected_at', 'rr.last_redirected_at', 'rr.google_location', 'rr.last_google_location', 'rr.google_review_clicked', 'c.last_name');
  if (rows.length >= SCAN_LIMIT) return true;
  const elsewhereInWindow = (ts, loc) => {
    const at = ts ? new Date(ts) : null;
    return Boolean(loc) && loc !== reviewLocationId
      && Boolean(at) && !Number.isNaN(at.getTime()) && at >= windowStart && at <= windowEnd;
  };
  return rows.some((row) => row.google_review_clicked === true
    && surnames.includes(normalizeName(row.last_name))
    && (elsewhereInWindow(row.redirected_at, row.google_location)
      || elsewhereInWindow(row.last_redirected_at, row.last_google_location)));
}

// ── Confident auto-link (GATE_REVIEW_CLICK_AUTOLINK; the click_name rung also
// needs GATE_REVIEW_CLICK_AUTOLINK_SURNAME) ──────────────────────────────────
//
// The suggestion list above tolerates ambiguity because a person reads it.
// Auto-linking tolerates none: a wrong link suppresses that customer's future
// review asks and can enroll them in a thank-you sequence. So the bar is
// deliberately higher than "nearest click". Three rungs, each on its own
// enough (owner rulings 2026-09-03), all requiring an active, unflagged
// customer whose click landed BEFORE the review within a tight window
// (people tap the link, then write — prod evidence: 45s, 2min and ~3h gaps):
//   sole_click — EXACTLY ONE clicker in the whole 72h window (even a
//     location-unstamped second clicker means a human decides) AND a
//     post-migration location pair that MATCHES the review's;
//   click_name — exactly one in-window clicker whose complete last name
//     ends the reviewer's display name — counted across EVERY location's
//     link, not just this GBP's. The surname is the corroboration the
//     post-migration stamp stands in for, so a legacy pair qualifies; any
//     of the customer's pairs stamped with a DIFFERENT location refuses;
//   click_near — the nearest click is within minutes of the review, its
//     pair is trusted and location-matched, and every other clicker in the
//     window (linked ones included) is hours away or after the review.
const AUTO_LINK_MAX_BEFORE_MS = 12 * 3600 * 1000;
const AUTO_LINK_NEAR_MS = 10 * 60 * 1000;
const AUTO_LINK_FAR_MS = 6 * 3600 * 1000;

/**
 * Decide whether click evidence alone is strong enough to link an unlinked
 * Google review to a customer with no human in the loop.
 *
 * @param {{review_created_at?: string|Date, location_id?: string}} review
 * @param {{conn?: object}} [options]
 * @returns {Promise<{customerId: string, clickedAt: string, clickOffsetMs: number, clickOffsetLabel: string, rung: 'sole_click'|'click_name'|'click_near', evidence: string, locationTrusted: boolean}|null>}
 *   null on any ambiguity or error — auto-link must fail toward the manual
 *   queue, never toward a guess. `evidence` is the admin-readable audit cue
 *   stating ONLY what the rung checked (GH codex r2 P2); `locationTrusted`
 *   is whether the click's location was observed with its timestamp and
 *   matches the review's — false for a legacy click_name pair, which could
 *   have landed on any location's form (GH codex r2 P1).
 *
 * The rungs are tried in order (RUNGS); the first decision wins, and a rung
 * that cannot decide yields to the next.
 */
async function findConfidentClickMatch(review, { conn = db } = {}) {
  try {
    // SCAN_LIMIT bounds the underlying query; a limit above it returns every
    // deduped candidate, which the rungs need. The surname rung ships DARK
    // on its own gate (#3822 r6: its ambiguity semantics were still
    // converging) — off, click_name never links and the inverse-location
    // scan it alone needs is skipped.
    const { isEnabled } = require('../config/feature-gates');
    const meta = { surnameRung: isEnabled('reviewClickAutoLinkSurname') };
    const candidates = await findLikelyReviewers(review, { conn, limit: SCAN_LIMIT, _meta: meta });
    // A scan that hit its row cap can't prove what else the window held
    // (pre-push P1 r3) — fail closed toward the manual queue.
    if (!candidates.length || meta.scanTruncated) return null;
    const scan = { candidates, all: meta.allCandidates, meta };
    for (const rung of RUNGS) {
      const decided = rung(scan);
      if (decided) return decided;
    }
    return null;
  } catch (err) {
    logger.warn(`[review-click-correlation] confident-match lookup failed: ${err.message}`);
    return null;
  }
}

// ---- rung ladder -----------------------------------------------------------
// Each rung sees the same scan: `candidates` = unlinked, active-enough
// customers ranked by findLikelyReviewers; `all` = ONE entry per clicker
// (their best click) in the RAW window, linked / archived / unstamped
// clickers included (`_meta.allCandidates`); `meta` = the scan's counters.

// Shared bar for every rung:
// - already marked as having reviewed (manual mark, no linked row): the
//   auto-link would add nothing and a later re-match correction would
//   clear a flag the auto-link never set (GH codex #3483 r1 P2);
// - inactive customer: the confirmation UI's candidate search only
//   offers active customers, so the link could never be human-confirmed
//   (GH codex #3483 r5);
// - the click came AFTER the review, or more than 12h before it.
const eligible = (c) => c.alreadyFlagged !== true
  && c.customerActive === true
  && c.clickedBeforeReview === true
  && c.clickOffsetMs <= AUTO_LINK_MAX_BEFORE_MS;
// A trusted pair: timestamp and location observed together post-migration
// AND the location is the review's (null = legacy = not confident).
// sole_click and click_near require it; click_name only reports it, as
// `locationTrusted`.
const trusted = (c) => c.pairTrusted === true && c.locationMatch === true;
const decision = (c, rung, evidence) => ({
  customerId: c.customerId,
  clickedAt: c.clickedAt,
  clickOffsetMs: c.clickOffsetMs,
  clickOffsetLabel: c.clickOffsetLabel,
  rung,
  evidence,
  locationTrusted: trusted(c),
});

// `evidence` states only what the rung verified — it is the audit cue for
// reversing a bad link, so a canned claim the rung never checked (a
// next-nearest click "hours earlier" that was actually after the review;
// "other names" with no other clicker) would mislead (GH codex r2 P2). The
// counts come from the same scan the rung decided on and count clickers,
// not clicks (GH codex r3 P2). A competitor is "at this location" only when
// its pair was stamped here — an admitted unstamped pair (locationMatch
// null) is named as such, never promoted to this location (GH codex r10
// P2, #3875 r1 P2).
const plural = (n, noun) => `${n} other ${noun}${n === 1 ? '' : 's'}`;
const AT_LOCATION = 'at this location';
const UNLOCATED = 'with no location recorded';
const locationOf = (c) => (c.locationMatch === true ? AT_LOCATION : UNLOCATED);
// "1 other clicker at this location", "2 other clickers with no location
// recorded" — one phrase per non-empty group, located first.
function clickerGroups(list) {
  return [AT_LOCATION, UNLOCATED]
    .map((where) => [where, list.filter((c) => locationOf(c) === where).length])
    .filter(([, n]) => n > 0)
    .map(([where, n]) => `${plural(n, 'clicker')} ${where}`);
}

// sole_click — the sole-clicker check holds over the RAW window, including
// clickers the suggestion list hides as already-attributed (their click may
// aim at a different location's profile): one distinct clicker means the
// one candidate IS that clicker.
function soleClickRung({ candidates, meta }) {
  const only = candidates[0];
  if (meta.distinctClickers !== 1 || !eligible(only) || !trusted(only)) return null;
  return decision(only, 'sole_click', 'only click in the window, same location');
}

// click_name — exactly one clicker in the RAW window carries the reviewer's
// complete surname (a linked same-surname clicker still competes — their
// click may aim at another location's profile; pre-push P1 — and so does
// one whose clicks all went to ANOTHER location's form, which the
// location-filtered scan never returns; pre-push r4 P1), and that one must
// be an unlinked candidate. Two surname matches ("Cruz" and "De La Cruz"
// both end "Maria De La Cruz") = a human decides. A legacy pair is fine
// (the surname corroborates); a customer with ANY pair stamped for a
// different location is not — the retained pair may be the untrusted first
// click while their newer tap went elsewhere (GH codex r1 P1), or a second
// request row of theirs may be stamped elsewhere (pre-push r5 P1). `all`
// holds archived clickers too — competition, never `named` (their
// customerActive is false; GH codex r6 P1).
function clickNameRung({ candidates, all, meta }) {
  if (!meta.surnameRung || meta.surnameClickerElsewhere === true) return null;
  const namedAll = all.filter((c) => c.nameMatch === true);
  if (namedAll.length !== 1) return null;
  const named = candidates.find((c) => c.customerId === namedAll[0].customerId);
  if (!named || !eligible(named) || named.locationConflict === true) return null;
  // Every other entry in `all` failed the surname test, and the inverse
  // scan found no same-surname click at any other location.
  const groups = clickerGroups(all.filter((c) => c.customerId !== named.customerId));
  return decision(named, 'click_name', `the reviewer's last name matches this customer's; ${
    groups.length ? `the ${groups.join(' and the ')} in the window had other last names` : 'no other clicker at this location in the window'}`);
}

// click_near — the nearest click is minutes before the review and every
// other clicker in the window (linked ones included) is hours away or after
// it. The nearest must itself be an unlinked, trusted, location-matched
// candidate — the same object, `candidates` being a filtered view of `all`.
function clickNearRung({ candidates, all }) {
  const before = all.filter((c) => c.clickOffsetMs >= 0).sort((a, b) => a.clickOffsetMs - b.clickOffsetMs);
  const near = candidates.find((c) => before.length && c.customerId === before[0].customerId);
  if (!near || near.clickOffsetMs > AUTO_LINK_NEAR_MS || !eligible(near) || !trusted(near)) return null;
  const crowded = all.some((c) => c.customerId !== near.customerId
    && c.clickOffsetMs >= 0 && c.clickOffsetMs < AUTO_LINK_FAR_MS);
  if (crowded) return null;
  // `before` is one entry per clicker, nearest first: [1] is the
  // next-nearest clicker's pre-review click (≥6h earlier, or none). A
  // clicker whose only in-window tap came AFTER the review is not
  // competition but is reported rather than denied.
  const afterCopy = clickerGroups(all.filter((c) => c.clickOffsetMs < 0))
    .map((group) => `; ${group} tapped only after it posted`).join('');
  return decision(near, 'click_near', `the nearest click at this location before the review; ${
    before[1] ? `the next-nearest clicker ${locationOf(before[1])} tapped ${before[1].clickOffsetLabel}` : 'no other clicker at this location tapped before it in the window'}${afterCopy}`);
}

const RUNGS = [soleClickRung, clickNameRung, clickNearRung];


module.exports = { findLikelyReviewers, findConfidentClickMatch, describeClickOffset, reviewerSurnames, AUTO_LINK_MAX_BEFORE_MS, AUTO_LINK_NEAR_MS, AUTO_LINK_FAR_MS };
