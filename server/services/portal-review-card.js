/**
 * The link behind the portal's one-tap Google review card (owner ruling
 * 2026-09-29). Nothing is sent from here.
 *
 * The pending-send state is read INDEPENDENTLY of the ask-eligibility outcome:
 * a customer who is at cap, in cooldown or in a cadence can still have a
 * one-off ask queued or mid-send, and a link that cannot consume it would let
 * the customer review AND still get that text.
 *
 *   - a queued / in-flight one-off is pending -> no card. Its own token cannot
 *     stop it (a click stamps the row; processScheduled still sends it), so
 *     there is no link that belongs to it and is safe to hand out;
 *   - an active cadence is pending -> only the customer's live delivered
 *     tokenized link (clicking /api/rate/<token>/go stamps the click and STOPS
 *     the cadence); never an older bare URL, which stops nothing;
 *   - nothing pending -> the live tokenized link, else the office's official
 *     g.page/r/<id>/review URL.
 * A DB error while reading the pending state throws (fail closed).
 */
const ReviewService = require('./review-request');

async function reviewCardLinkFor(customerId, office) {
  const pending = await ReviewService.pendingAskState(customerId);
  if (pending.oneOff) return null;
  const live = await ReviewService.livePortalReviewUrlFor(customerId).catch(() => null);
  if (live) return live;
  if (pending.cadence) return null;
  return office?.googleReviewUrl || null;
}

module.exports = { reviewCardLinkFor };
