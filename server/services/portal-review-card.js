/**
 * The link behind the portal's one-tap Google review card (owner ruling
 * 2026-09-29). Nothing is sent from here.
 *
 * The whole "can another review ask still reach this customer later?"
 * question is ReviewService.futureAskState — ONE chokepoint that lists every
 * automatic or resumable sender (active / deferred / redeeming / parked
 * cadences, queued one-offs, unsent 'sending' claims, due Day-3 follow-ups, a
 * parked summary the recovery will re-enroll) and says whether one tracked
 * click really stops each of them. The tracked /api/rate/<token>/go link runs
 * ReviewService.stopFutureAsks, so:
 *
 *   - nothing possible  -> the live tracked /go link if any, else the office's
 *                          official g.page/r/<id>/review URL;
 *   - something possible, and EVERY listed path is stoppable -> only the live
 *                          delivered token's /go link (its click stops them
 *                          all); no live token -> no card, never a bare URL;
 *   - any listed path NOT stoppable (an in-flight send, a cadence mid-lease, a
 *                          summary recovery with nothing to relabel) -> no card.
 * A DB error while reading the state throws (fail closed).
 */
const ReviewService = require('./review-request');
const { publicPortalUrl } = require('../utils/portal-url');

const goUrl = (token) => `${publicPortalUrl()}/api/rate/${token}/go`;

async function reviewCardLinkFor(customerId, office) {
  const state = await ReviewService.futureAskState(customerId);
  if (state.stoppableToken) return goUrl(state.stoppableToken);
  if (state.possible) return null;
  return office?.googleReviewUrl || null;
}

module.exports = { reviewCardLinkFor };
