'use strict';

/**
 * The review matcher's pass (owner 2026-10-31, review matching plan PR 3; GATE_REVIEW_NAME_MATCH_V2).
 * It scores every live Google review with the evidence rules (review-link-evidence.js) against every
 * live customer (review-link-candidates.js) and records the decision on google_reviews
 * (name_match_*): link / link_confirm / pause / household / queue / reject for an unlinked review,
 * and 'disputed' for a linked review whose customer's first known contact came after it.
 *
 * Nothing here links a review, marks a customer or sends anything. The Reviews match queue lists the
 * decisions that name a customer for one tap (the existing manual match does the link), and a later
 * send-time guard reads them under its own gate. A customer a person ruled out for a review
 * (name_match_dismissed_customer_ids) is never suggested for that review again.
 *
 * Mode (reviewNameMatchMode, read at call time): off = nothing runs; shadow = score and log the
 * counts, write nothing; on = write the decisions that changed. Runs after the hourly review sync.
 */

const db = require('../models/db');
const logger = require('./logger');
const { reviewNameMatchMode } = require('../config/feature-gates');
const {
  recordName, firstKnownContactAt, dateVerdict, scoreCandidate, decideReviewLink,
} = require('./review-link-evidence');
const { loadEvidenceCandidates } = require('./review-link-candidates');

// Results that name the customer the review most likely belongs to.
const NAMES_A_CUSTOMER = new Set(['link', 'link_confirm', 'pause', 'household']);
const NO_DECISION = Object.freeze({ result: null, customerId: null, reason: null });

const idOf = (value) => (value === null || value === undefined ? null : String(value));
const ruledOut = (review) => new Set((review.name_match_dismissed_customer_ids || []).map(String));

// The decision for one unlinked review.
function decideUnlinked(review, candidates, { linkedBy, surnameHolderCount }) {
  const subject = { reviewerName: review.reviewer_name, reviewedAt: review.review_created_at, locationId: review.location_id };
  const excluded = ruledOut(review);
  const scored = candidates
    .filter((c) => !excluded.has(idOf(c.customerId)))
    .map((c) => scoreCandidate(subject, { ...c, linkedProfiles: (linkedBy.get(idOf(c.customerId)) || []).map((r) => r.location_id) }));
  const decision = decideReviewLink(scored, { surnameHolderCount });
  if (decision.result === 'none') return NO_DECISION;
  return {
    result: decision.result,
    customerId: NAMES_A_CUSTOMER.has(decision.result) ? decision.top.customerId : null,
    reason: decision.reason,
  };
}

// A linked review is disputed when its customer's first known contact came after it (older clashes
// too: this only lists the link for a person, it never unlinks). A person who kept the link is not
// asked again, and a click auto-link is left to its own confirm row in the queue.
function decideLinked(review, byId) {
  const linked = byId.get(idOf(review.customer_id));
  if (!linked || review.link_source === 'click_auto' || ruledOut(review).has(idOf(review.customer_id))) return NO_DECISION;
  const dates = dateVerdict(review.review_created_at, firstKnownContactAt(linked.timeline));
  if (dates !== 'clash' && dates !== 'clash_early') return NO_DECISION;
  return { result: 'disputed', customerId: review.customer_id, reason: dates };
}

const sameDecision = (review, next) => (review.name_match_result || null) === next.result
  && idOf(review.name_match_customer_id) === idOf(next.customerId)
  && (review.name_match_reason || null) === next.reason;

// Every live review's decision, from one read of the reviews and one of the customers.
async function computeDecisions(conn) {
  const reviews = await conn('google_reviews')
    .whereRaw("(reviewer_name IS NULL OR reviewer_name <> '_stats')")
    .whereNull('missing_since')
    .select('id', 'location_id', 'reviewer_name', 'review_created_at', 'customer_id', 'link_source',
      'name_match_result', 'name_match_customer_id', 'name_match_reason', 'name_match_dismissed_customer_ids', 'name_match_dismissed_at');
  const candidates = await loadEvidenceCandidates(conn);
  const byId = new Map(candidates.map((c) => [idOf(c.customerId), c]));
  const holders = new Map();
  for (const c of candidates) {
    const { last } = recordName(c.holder.first, c.holder.last);
    if (last) holders.set(last, (holders.get(last) || 0) + 1);
  }
  const linkedBy = new Map();
  for (const r of reviews.filter((x) => x.customer_id)) {
    const list = linkedBy.get(idOf(r.customer_id)) || [];
    list.push(r);
    linkedBy.set(idOf(r.customer_id), list);
  }
  const context = { linkedBy, surnameHolderCount: (surname) => holders.get(surname) || 0 };
  // Only a customer a person can confirm in the queue is ever suggested (the candidate search and
  // the pin both require active); a linked review is judged on its customer whatever their status.
  const suggestible = candidates.filter((c) => c.active !== false);
  const decisions = [];
  for (const review of reviews) {
    decisions.push({
      review,
      next: review.customer_id ? decideLinked(review, byId) : decideUnlinked(review, suggestible, context),
    });
    // The pass runs inside the web server: requests and timers get a turn between reviews.
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  return decisions;
}

async function runReviewNameMatch({ conn = db, mode = reviewNameMatchMode(), now = new Date() } = {}) {
  if (mode !== 'shadow' && mode !== 'on') return { mode: 'off', skipped: true };
  const decisions = await computeDecisions(conn);
  const counts = {};
  for (const { next } of decisions) counts[next.result || 'none'] = (counts[next.result || 'none'] || 0) + 1;
  const changes = decisions.filter(({ review, next }) => !sameDecision(review, next));
  logger.info(`[review-name-match] ${mode}: ${decisions.length} reviews ${JSON.stringify(counts)}, ${changes.length} changed`);
  if (mode !== 'on') return { mode, reviews: decisions.length, counts, changed: changes.length, written: 0 };

  let written = 0;
  for (const { review, next } of changes) {
    // Only onto the row as it was read: a manual match, a removal or a dismissal that committed
    // since the read keeps the row as it is until the next pass.
    const query = conn('google_reviews').where({ id: review.id }).whereNull('missing_since')
      .whereRaw('name_match_dismissed_at IS NOT DISTINCT FROM ?::timestamptz', [review.name_match_dismissed_at || null]);
    if (review.customer_id) query.where({ customer_id: review.customer_id });
    else query.whereNull('customer_id');
    written += await query.update({
      name_match_result: next.result,
      name_match_customer_id: next.customerId,
      name_match_reason: next.reason,
      name_match_at: now,
    });
  }
  return { mode, reviews: decisions.length, counts, changed: changes.length, written };
}

const DISMISSABLE = new Set([...NAMES_A_CUSTOMER, 'disputed']);

// Reviews > Dismiss: a person rules the suggested customer out for this review (or keeps a disputed
// link). The decision clears at once and the matcher never names that customer for this review
// again. Conditional on the decision AND the link state the person saw: a suggestion matched by
// someone else meanwhile, or a decision a pass moved, gets a 409.
async function dismissNameMatch({ reviewId, customerId, result, conn = db } = {}) {
  if (!reviewId || !customerId || !DISMISSABLE.has(result)) {
    const err = new Error('reviewId, customerId and the shown result required');
    err.statusCode = 400;
    throw err;
  }
  const query = conn('google_reviews').where({ id: reviewId, name_match_customer_id: customerId, name_match_result: result });
  if (result === 'disputed') query.where({ customer_id: customerId });
  else query.whereNull('customer_id');
  const updated = await query
    .update({
      name_match_dismissed_customer_ids: conn.raw('array_append(name_match_dismissed_customer_ids, ?::uuid)', [customerId]),
      name_match_dismissed_at: new Date(),
      name_match_result: null,
      name_match_customer_id: null,
      name_match_reason: null,
    });
  if (!updated) {
    const err = new Error('This suggestion changed since the page loaded. Refresh and try again.');
    err.statusCode = 409;
    throw err;
  }
  return { dismissed: true };
}

module.exports = { runReviewNameMatch, computeDecisions, dismissNameMatch };
