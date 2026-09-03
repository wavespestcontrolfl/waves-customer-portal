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
 * A name for matching: lowercased, diacritics stripped, punctuation trimmed,
 * whitespace collapsed ("Muñoz-Pérez" → "munoz-perez", "De La Cruz" →
 * "de la cruz"). '' when nothing usable remains.
 */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z'\- ]/g, '')
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
 * surname and returns [].
 */
function reviewerSurnames(reviewerName) {
  const tokens = normalizeName(reviewerName).split(' ').filter(Boolean);
  if (tokens.length < 2) return [];
  return tokens.map((_, i) => tokens.slice(i).join(' ')).filter((s) => s.length >= 2);
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
  const reviewAtRaw = review?.review_created_at;
  const reviewAt = reviewAtRaw ? new Date(reviewAtRaw) : null;
  if (!reviewAt || Number.isNaN(reviewAt.getTime())) return [];
  const surnames = reviewerSurnames(review?.reviewer_name);

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
        { ts: row.last_redirected_at, loc: row.last_google_location || null, trusted: Boolean(row.last_google_location) },
        { ts: row.redirected_at, loc: row.google_location || null, trusted: false },
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
        // active=true, so a null-active link would be unconfirmable.
        customerActive: row.active === true,
        // Another of this customer's pairs is stamped for a DIFFERENT
        // location — see `conflicting` above.
        locationConflict: conflicting.has(row.customer_id),
        // The reviewer's display-name surname equals this customer's
        // COMPLETE last name (owner ruling 2026-09-03: the matcher weighs
        // the last name; GH codex r1 P1: whole surname, not the final token).
        nameMatch: surnames.includes(normalizeName(row.last_name)),
      });
    const all = [...byCustomer.values()].map(toCandidate);
    // Every clicker in the window, linked ones included — the confident
    // matcher's proximity rung needs each competing click's offset, not
    // just the count.
    if (_meta) _meta.allCandidates = all;

    // A customer already linked to a synced review is attributed — excluded
    // from the SUGGESTION list so it only holds open questions (codex #3264).
    // Surname matches lead; within a tier the nearest click wins.
    return all
      .filter((c) => !linked.has(c.customerId))
      .sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || Math.abs(a.clickOffsetMs) - Math.abs(b.clickOffsetMs))
      .slice(0, Math.max(1, limit));
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
// deliberately higher than "nearest click". Three rungs, each on its own
// enough (owner rulings 2026-09-03), all requiring an active, unflagged
// customer whose click landed BEFORE the review within a tight window
// (people tap the link, then write — prod evidence: 45s, 2min and ~3h gaps):
//   sole_click — EXACTLY ONE clicker in the whole 72h window (even a
//     location-unstamped second clicker means a human decides) AND a
//     post-migration location pair that MATCHES the review's;
//   click_name — exactly one in-window clicker whose complete last name
//     ends the reviewer's display name. The surname is the corroboration
//     the post-migration stamp stands in for, so a legacy pair qualifies;
//     any of the customer's pairs stamped with a DIFFERENT location
//     refuses;
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
 * @returns {Promise<{customerId: string, clickedAt: string, clickOffsetMs: number, clickOffsetLabel: string, rung: 'sole_click'|'click_name'|'click_near'}|null>}
 *   null on any ambiguity or error — auto-link must fail toward the manual
 *   queue, never toward a guess.
 */
async function findConfidentClickMatch(review, { conn = db } = {}) {
  try {
    // SCAN_LIMIT bounds the underlying query; a limit above it returns every
    // deduped candidate, which the rungs below need.
    const meta = {};
    const candidates = await findLikelyReviewers(review, { conn, limit: SCAN_LIMIT, _meta: meta });
    if (!candidates.length) return null;
    // A scan that hit its row cap can't prove what else the window held
    // (pre-push P1 r3) — fail closed toward the manual queue.
    if (meta.scanTruncated) return null;
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
    const decision = (c, rung) => ({
      customerId: c.customerId,
      clickedAt: c.clickedAt,
      clickOffsetMs: c.clickOffsetMs,
      clickOffsetLabel: c.clickOffsetLabel,
      rung,
    });

    // sole_click — the sole-clicker check holds over the RAW window,
    // including clickers the suggestion list hides as already-attributed
    // (their click may aim at a different location's profile). Location
    // must be the trusted post-migration pair (null = legacy = not confident).
    if (candidates.length === 1 && meta.distinctClickers === 1) {
      const only = candidates[0];
      if (eligible(only) && only.pairTrusted === true && only.locationMatch === true) return decision(only, 'sole_click');
    }

    // click_name — exactly one clicker in the RAW window carries the
    // reviewer's complete surname (a linked same-surname clicker still
    // competes — their click may aim at another location's profile;
    // pre-push P1), and that one must be an unlinked candidate. Two
    // surname matches ("Cruz" and "De La Cruz" both end "Maria De La
    // Cruz") = a human decides. A legacy pair is fine (the surname
    // corroborates); a customer with ANY pair stamped for a different
    // location is not — the retained pair may be the untrusted first click
    // while their newer tap went elsewhere (GH codex r1 P1).
    const all = meta.allCandidates || [];
    const namedAll = all.filter((c) => c.nameMatch === true);
    const named = namedAll.length === 1 ? candidates.find((c) => c.customerId === namedAll[0].customerId) : null;
    if (named && eligible(named) && named.locationConflict !== true) {
      return decision(named, 'click_name');
    }

    // click_near — the nearest click is minutes before the review and every
    // other clicker in the window (linked ones included) is hours away or
    // after it. The nearest must itself be an unlinked, trusted,
    // location-matched candidate.
    const before = all.filter((c) => c.clickOffsetMs >= 0).sort((a, b) => a.clickOffsetMs - b.clickOffsetMs);
    const nearest = before[0];
    if (!nearest || nearest.clickOffsetMs > AUTO_LINK_NEAR_MS) return null;
    const near = candidates.find((c) => c.customerId === nearest.customerId);
    if (!near || near.clickOffsetMs !== nearest.clickOffsetMs) return null;
    if (!eligible(near) || near.pairTrusted !== true || near.locationMatch !== true) return null;
    const crowded = all.some((c) => c.customerId !== near.customerId
      && c.clickOffsetMs >= 0 && c.clickOffsetMs < AUTO_LINK_FAR_MS);
    if (crowded) return null;
    return decision(near, 'click_near');
  } catch (err) {
    logger.warn(`[review-click-correlation] confident-match lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = { findLikelyReviewers, findConfidentClickMatch, describeClickOffset, reviewerSurnames, AUTO_LINK_MAX_BEFORE_MS, AUTO_LINK_NEAR_MS, AUTO_LINK_FAR_MS };
