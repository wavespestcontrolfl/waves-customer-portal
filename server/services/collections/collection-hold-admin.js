/**
 * Staff view + release of a customer's collections holds (B10).
 *
 * A collections dispute hold stops every off-session charge (collection-hold.js)
 * and, until now, had no way to be lifted except the ops script. Releasing
 * stamps released_at through the ONE writer (flags.releaseFlag) and every
 * lane resumes on its next attempt: the monthly retry sweep collects its armed
 * hold-deferred row, completion / sweep / termite lanes charge normally, and
 * the closeout (visit-completion-payment) is retryable, never durably flagged.
 * Only `collection_hold` can be released here; other flags keep their own path.
 *
 * Owner ruling 2026-09-30: releasing the hold also SENDS every invoice whose
 * pay link the hold withheld (marked by the withholding lane, see
 * collection-hold.js). That send runs AFTER the release commits
 * (sendWithheldInvoicesAfterRelease) and can never undo it.
 */
const { activeFlags, releaseFlag } = require('./outbound-voice/flags');
const { HOLD_FLAG, DISPUTE_REASON_PREFIX, releaseWithheldInvoices } = require('./collection-hold');
const logger = require('../logger');

async function listCollectionHolds(customerId) {
  const rows = await activeFlags(customerId);
  return rows
    .filter((r) => r.flag === HOLD_FLAG)
    .map((r) => ({
      flag: r.flag,
      reason: r.reason || null,
      created_by: r.created_by || null,
      created_at: r.created_at,
      // Only a dispute hold stops charges; fallback holds only pause outreach.
      stops_charges: String(r.reason || '').toLowerCase().startsWith(DISPUTE_REASON_PREFIX),
    }));
}

// Queue the invoices the hold withheld onto the normal scheduled-send queue.
// Call it AFTER the release has committed. Never throws: a failure is logged
// and raised to the office as a dispatch alert, and the release stands. Nothing
// is queued while the customer still has another active dispute hold.
async function sendWithheldInvoicesAfterRelease(customerId) {
  try {
    const { queued } = await releaseWithheldInvoices({ customerId });
    if (queued.length) {
      logger.info(`[collection-hold] released hold for customer ${customerId}: queued ${queued.length} withheld invoice(s) for send`);
    }
    return { ok: true, queued };
  } catch (err) {
    logger.error(`[collection-hold] release committed for customer ${customerId} but sending the withheld invoice(s) FAILED: ${err.message}`);
    try {
      await require('../dispatch-alerts').createAlert({
        type: 'collection_hold_release_send_failed',
        severity: 'warn',
        payload: {
          customerId: String(customerId),
          error: String(err.message || err).slice(0, 300),
          action: 'The dispute hold was released, but the invoice(s) withheld during it were not sent. Send them from the invoice page.',
        },
      });
    } catch (alertErr) {
      logger.error(`[collection-hold] office alert for the failed post-release send (customer ${customerId}) also failed: ${alertErr.message}`);
    }
    return { ok: false, error: err.message, queued: [] };
  }
}

async function releaseCollectionHold(customerId, { trx = null } = {}) {
  const res = await releaseFlag({ customerId, flag: HOLD_FLAG, trx });
  // With a caller-owned transaction the release has not committed yet, so the
  // caller sends after its own commit (sendWithheldInvoicesAfterRelease).
  if (!trx && res.ok) res.withheldSend = await sendWithheldInvoicesAfterRelease(customerId);
  return res;
}

module.exports = { listCollectionHolds, releaseCollectionHold, sendWithheldInvoicesAfterRelease };
