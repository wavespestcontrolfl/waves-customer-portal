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
async function findLikelyReviewers(review, { conn = db, limit = DEFAULT_LIMIT } = {}) {
  const reviewAtRaw = review?.review_created_at;
  const reviewAt = reviewAtRaw ? new Date(reviewAtRaw) : null;
  if (!reviewAt || Number.isNaN(reviewAt.getTime())) return [];

  try {
    const windowStart = new Date(reviewAt.getTime() - WINDOW_BEFORE_HOURS * 3600 * 1000);
    const windowEnd = new Date(reviewAt.getTime() + WINDOW_AFTER_HOURS * 3600 * 1000);

    const clicks = await conn('review_requests as rr')
      .join('customers as c', 'rr.customer_id', 'c.id')
      .whereNull('c.deleted_at')
      .whereNotNull('rr.redirected_at')
      .where('rr.redirected_at', '>=', windowStart)
      .where('rr.redirected_at', '<=', windowEnd)
      .orderBy('rr.redirected_at', 'desc')
      .limit(SCAN_LIMIT)
      .select(
        'rr.customer_id',
        'rr.redirected_at',
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
      );
    if (!clicks.length) return [];

    // A customer already linked to a synced review is attributed — their click
    // explains their OWN review, not this one. Excluded rather than annotated
    // so the list only holds open questions.
    let linked = new Set();
    try {
      const ids = [...new Set(clicks.map((r) => r.customer_id))];
      const linkedRows = await conn('google_reviews')
        .whereIn('customer_id', ids)
        .where('reviewer_name', '!=', '_stats')
        .select('customer_id');
      linked = new Set(linkedRows.map((r) => r.customer_id));
    } catch {
      /* google_reviews may not exist in some deploys — skip the exclusion */
    }

    // One entry per customer, nearest click wins.
    const byCustomer = new Map();
    for (const row of clicks) {
      if (linked.has(row.customer_id)) continue;
      const clickedAt = new Date(row.redirected_at);
      if (Number.isNaN(clickedAt.getTime())) continue;
      const clickOffsetMs = reviewAt.getTime() - clickedAt.getTime();
      const prev = byCustomer.get(row.customer_id);
      if (!prev || Math.abs(clickOffsetMs) < Math.abs(prev.clickOffsetMs)) {
        byCustomer.set(row.customer_id, { row, clickedAt, clickOffsetMs });
      }
    }

    return [...byCustomer.values()]
      .sort((a, b) => Math.abs(a.clickOffsetMs) - Math.abs(b.clickOffsetMs))
      .slice(0, Math.max(1, limit))
      .map(({ row, clickedAt, clickOffsetMs }) => ({
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
        // null when the click predates google_location stamping.
        locationMatch: row.google_location && review?.location_id
          ? row.google_location === review.location_id
          : null,
        alreadyFlagged: row.has_left_google_review === true,
      }));
  } catch (err) {
    // ID-only logging (AGENTS.md) — no names in plaintext logs.
    logger.warn(`[review-click-correlation] likely-reviewer lookup failed: ${err.message}`);
    return [];
  }
}

module.exports = { findLikelyReviewers, describeClickOffset };
