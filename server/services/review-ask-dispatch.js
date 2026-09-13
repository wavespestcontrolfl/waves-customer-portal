const history = require('./review-ask-history');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const { formatETDate, formatETTime } = require('../utils/datetime-et');

// The callback includes provider delivery and its durable delivery stamp.
// Callers retain their recipient, consent, claim and outcome handling.
async function dispatchReviewAsk(customerId, dispatch, { excludeRequestId = null } = {}) {
  if (!customerId) return { sent: false, blocked: true, code: 'REVIEW_CUSTOMER_REQUIRED',
    reason: 'Select the customer receiving this review request before sending.', httpStatus: 409 };
  const result = await runExclusive(`review-send:${customerId}`, async () => {
    let pipelineAt;
    let manualAt;
    try {
      [pipelineAt, manualAt] = await Promise.all([
        history.lastDeliveredAskAt(customerId, { excludeRequestId }),
        history.lastManualAskAt(customerId, { since: new Date(Date.now() - history.ASK_SPACING_MS) }),
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

module.exports = { dispatchReviewAsk };
