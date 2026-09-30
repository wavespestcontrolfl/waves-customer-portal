const history = require('./review-ask-history');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const { formatETDate, formatETTime } = require('../utils/datetime-et');
const logger = require('./logger');

// The send-time click guard for a bundled ask, run while the caller holds the
// per-customer review-send lock (the lock the click's own stopFutureAsks
// takes): 'clicked' after a tracked tap since the ask's visit, 'unknown' when
// the click state cannot be read (callers fail closed), else null.
async function clickGate(reviewRequestId) {
  try {
    return (await require('./review-click-guard').askIdSuppressedByClick(reviewRequestId)) ? 'clicked' : null;
  } catch (err) {
    logger.warn(`[review-ask] click-state read failed; bundled ask held (reviewRequestId=${reviewRequestId} errType=${err?.name})`);
    return 'unknown';
  }
}

// The callback includes provider delivery and its durable delivery stamp.
// Callers retain their recipient, consent, claim and outcome handling.
async function dispatchReviewAsk(customerId, dispatch, { excludeRequestId = null, excludeReservationId = null, clickAskId = null } = {}) {
  if (!customerId) return { sent: false, blocked: true, code: 'REVIEW_CUSTOMER_REQUIRED',
    reason: 'Select the customer receiving this review request before sending.', httpStatus: 409 };
  const result = await runExclusive(`review-send:${customerId}`, async () => {
    // clickAskId: the review request this send carries (a bundled completion
    // ask), judged under the same lock hold as the provider call below.
    const click = clickAskId ? await clickGate(clickAskId) : null;
    if (click === 'clicked') return { sent: false, blocked: true, code: 'REVIEW_LINK_CLICKED',
      reason: require('./review-click-guard').REVIEW_LINK_CLICKED_REASON, httpStatus: 409 };
    if (click === 'unknown') return { sent: false, blocked: true, code: 'REVIEW_CLICK_STATE_UNAVAILABLE',
      reason: 'Could not confirm whether this customer already tapped their review link. Try again shortly.', httpStatus: 503 };
    let pipelineAt;
    let manualAt;
    try {
      [pipelineAt, manualAt] = await Promise.all([
        history.lastDeliveredAskAt(customerId, { excludeRequestId }),
        // excludeReservationId: a caller that already reserved sms_log
        // evidence for THIS attempt (under the same lock, before this call)
        // excludes it here — it is this attempt's own claim, not prior
        // evidence to space against.
        history.lastManualAskAt(customerId, { since: new Date(Date.now() - history.ASK_SPACING_MS), excludeReservationId }),
      ]);
    } catch {
      return { sent: false, blocked: true, code: 'REVIEW_HISTORY_UNAVAILABLE',
        reason: 'Could not verify recent review requests. Try again after review history is available.', httpStatus: 503 };
    }
    const lastAt = Math.max(pipelineAt?.getTime() || 0, manualAt?.getTime() || 0);
    const nextAt = new Date(lastAt + history.ASK_SPACING_MS);
    if (lastAt && nextAt.getTime() > Date.now()) {
      return { sent: false, blocked: true, code: 'REVIEW_ASK_SPACING', nextAllowedAt: nextAt.toISOString(),
        reason: `A recent or unresolved review request is still inside the 72-hour window. The next ask can be sent after ${formatETDate(nextAt)} at ${formatETTime(nextAt)} Eastern.`, httpStatus: 409 };
    }
    return dispatch();
  }, { recordHealth: false, waitForSlot: false });
  return wasLockSkipped(result)
    ? { sent: false, blocked: true, code: 'REVIEW_SEND_BUSY',
      reason: 'A review request to this customer is already being sent. Try again in a moment.', httpStatus: 409 }
    : result;
}

// An immediate completion text's bundled ask (already spacing-checked when it
// was minted) gets the same click gate, and the text goes out under that same
// lock hold, so a tap cannot land between the check and the provider call.
// send(drop) runs with drop = null when the line may ride, else 'clicked',
// 'unknown' or 'busy' (another review send holds the lock, or the lock itself
// failed; send then runs unlocked) and must strip the line before it texts.
async function withBundledAskGate(customerId, reviewRequestId, send) {
  let started = false;
  const run = (drop) => { started = true; return send(drop); };
  let result;
  try {
    result = await runExclusive(`review-send:${customerId}`, async () => ({ value: await run(await clickGate(reviewRequestId)) }),
      { recordHealth: false, waitForSlot: false });
  } catch (err) {
    if (started) throw err;
    logger.warn(`[review-ask] review-send lock failed; bundled ask held (reviewRequestId=${reviewRequestId} errType=${err?.name})`);
    return run('unknown');
  }
  return wasLockSkipped(result) ? run('busy') : result.value;
}

module.exports = { dispatchReviewAsk, withBundledAskGate };
