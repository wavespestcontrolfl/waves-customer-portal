'use strict';

const TABLE = 'estimate_recurring_capture_dispositions';
const READ_ERROR_CODE = 'RECURRING_CARD_VERIFICATION_UNAVAILABLE';
const READ_ERROR_MESSAGE = 'We could not verify your saved payment method. Please try again.';

// Read-only lookup. Callers that are arbitrating acceptance or recovery must
// pass their existing estimate-lock transaction as `database`; this helper
// intentionally does not acquire a second transaction or contact Stripe.
async function findCaptureDisposition(database, { estimateId, setupIntentId } = {}) {
  if (!estimateId || !setupIntentId) return null;
  try {
    const row = await database(TABLE)
      .where({ estimate_id: estimateId, setup_intent_id: setupIntentId })
      .first('discard_requested_at', 'retired_at', 'legacy_recovery_claimed_at');
    return row || null;
  } catch {
    const error = new Error(READ_ERROR_MESSAGE);
    error.statusCode = 503;
    error.status = 503;
    error.isOperational = true;
    error.code = READ_ERROR_CODE;
    throw error;
  }
}

module.exports = { findCaptureDisposition };
