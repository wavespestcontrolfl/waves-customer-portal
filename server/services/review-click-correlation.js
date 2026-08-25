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
 *   locationMatch: boolean|null, alreadyFlagged: boolean
 * }>>} nearest-click-first; [] on missing/invalid review timestamp or any
 * query error (suggestions are best-effort and must never break a caller).
 */
async function findLikelyReviewers(review, { conn = db, limit = DEFAULT_LIMIT, _meta = null } = {}) {
  const reviewAtRaw = review?.review_created_at;
  const reviewAt = reviewAtRaw ? new Date(reviewAtRaw) : null;
  if (!reviewAt || Number.isNaN(reviewAt.getTime())) return [];

  try {
    const windowStart = new Date(reviewAt.getTime() - WINDOW_BEFORE_HOURS * 3600 * 1000);
    const windowEnd = new Date(reviewAt.getTime() + WINDOW_AFTER_HOURS * 3600 * 1000);

    const reviewLocationId = review?.location_id || null;
    let query = conn('review_requests as rr')
      .join('customers as c', 'rr.customer_id', 'c.id')
      .whereNull('c.deleted_at')
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
      query = query.where(function locationFilter() {
        this.whereNull('rr.google_location')
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
      );
    if (!clicks.length) return [];

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
        { ts: row.last_redirected_at, loc: row.last_google_location || null, trusted: Boolean(row.last_google_location) },
        { ts: row.redirected_at, loc: row.google_location || null, trusted: false },
      ];
      const seenTs = new Set();
      for (const { ts, loc, trusted } of pairs) {
        if (!ts || seenTs.has(String(ts))) continue;
        seenTs.add(String(ts));
        if (reviewLocationId && loc && loc !== reviewLocationId) continue;
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

    // Distinct clickers BEFORE the linked-customer exclusion below. The
    // confident auto-link's sole-clicker check must see every competing
    // click in the window: a customer the suggestion list hides as
    // already-attributed can still review a DIFFERENT location's profile,
    // so their click is competing evidence, not noise (pre-push P1).
    if (_meta) {
      _meta.distinctClickers = byCustomer.size;
      // A scan that filled SCAN_LIMIT may have truncated an older click out
      // of the window — sole-clicker can't be asserted over a partial read.
      _meta.scanTruncated = clicks.length >= SCAN_LIMIT;
    }

    // A customer already linked to a synced review is attributed — excluded
    // from the SUGGESTION list so it only holds open questions (codex #3264).
    return [...byCustomer.values()]
      .filter(({ row }) => !linked.has(row.customer_id))
      .sort((a, b) => Math.abs(a.clickOffsetMs) - Math.abs(b.clickOffsetMs))
      .slice(0, Math.max(1, limit))
      .map(({ row, clickedAt, clickOffsetMs, pairLoc, pairTrusted }) => ({
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
        // false only when the customer row explicitly carries active=false.
        customerActive: row.active !== false,
      }));
  } catch (err) {
    // ID-only logging (AGENTS.md) — no names in plaintext logs.
    logger.warn(`[review-click-correlation] likely-reviewer lookup failed: ${err.message}`);
    return [];
  }
}

// ── Confident auto-link (GATE_REVIEW_CLICK_AUTOLINK) ────────────────────────
//
// The suggestion list above tolerates ambiguity because a person reads it.
// Auto-linking tolerates none: a wrong link suppresses that customer's future
// review asks and can enroll them in a thank-you sequence. So the bar is
// deliberately higher than "nearest click":
//   - EXACTLY ONE candidate customer in the whole correlation window (a
//     second clicker anywhere in the 72h window — even location-unstamped —
//     means a human decides);
//   - the click's stamped GBP location MATCHES the review's (null = legacy
//     unstamped click = not confident);
//   - the click landed BEFORE the review, within a tight window (people tap
//     the link, then write — prod evidence: 2min and ~3h gaps).
const AUTO_LINK_MAX_BEFORE_MS = 12 * 3600 * 1000;

/**
 * Decide whether click evidence alone is strong enough to link an unlinked
 * Google review to a customer with no human in the loop.
 *
 * @param {{review_created_at?: string|Date, location_id?: string}} review
 * @param {{conn?: object}} [options]
 * @returns {Promise<{customerId: string, clickedAt: string, clickOffsetMs: number, clickOffsetLabel: string}|null>}
 *   null on any ambiguity or error — auto-link must fail toward the manual
 *   queue, never toward a guess.
 */
async function findConfidentClickMatch(review, { conn = db } = {}) {
  try {
    // SCAN_LIMIT bounds the underlying query; a limit above it returns every
    // deduped candidate, which the sole-candidate check needs.
    const meta = {};
    const candidates = await findLikelyReviewers(review, { conn, limit: SCAN_LIMIT, _meta: meta });
    if (candidates.length !== 1) return null;
    // Sole clicker must hold over the RAW window — including clickers the
    // suggestion list excludes as already-attributed (their click may aim at
    // a different location's profile). Anything else is ambiguity, and a
    // scan that hit its row cap can't prove the window held no one else
    // (pre-push P1 r3) — fail closed toward the manual queue.
    if (meta.distinctClickers !== 1) return null;
    if (meta.scanTruncated) return null;
    const only = candidates[0];
    // Already marked as having reviewed (manual mark, no linked row): the
    // auto-link would add nothing they don't have, and a later re-match
    // correction would clear a flag the auto-link never set (GH codex #3483
    // r1 P2). Their review stays a manual-queue question.
    if (only.alreadyFlagged) return null;
    // Inactive customer: the confirmation UI's candidate search only offers
    // active customers, so this link could never be human-confirmed and
    // would sit click_auto forever (GH codex #3483 r5) — manual queue.
    if (only.customerActive === false) return null;
    // Untrusted timestamp/location pair (legacy drift — GH codex r5): the
    // evidence may pair a click time with a location it never routed to.
    if (only.pairTrusted !== true) return null;
    if (only.locationMatch !== true) return null;
    if (!only.clickedBeforeReview) return null;
    if (only.clickOffsetMs > AUTO_LINK_MAX_BEFORE_MS) return null;
    return {
      customerId: only.customerId,
      clickedAt: only.clickedAt,
      clickOffsetMs: only.clickOffsetMs,
      clickOffsetLabel: only.clickOffsetLabel,
    };
  } catch (err) {
    logger.warn(`[review-click-correlation] confident-match lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = { findLikelyReviewers, findConfidentClickMatch, describeClickOffset, AUTO_LINK_MAX_BEFORE_MS };
