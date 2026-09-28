/**
 * Slot-proof reconciler — re-judges promises kept by a booking for their
 * promised slot whose proof the records now contradict (visit cancelled,
 * skipped or moved; call relinked; grounding rewritten by a reprocess).
 *
 * call-commitments.listSlotKeptCallIds finds them; refreshFulfillment
 * reopens each one the facts no longer support. The commitments watchdog
 * does the same before paging, but it runs every five minutes only with
 * callback cards on, hourly only with the follow-up pager on, and otherwise
 * once a day — so this job runs on the commitments gate alone and a lapsed
 * promise is back in Owed within fifteen minutes under any gate combination
 * (codex #5081 r8 P2). Off → no-op, nothing written.
 */
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

async function runSlotProofReconciler() {
  if (!isEnabled('callCommitments')) return { skipped: true, reason: 'gated_off' };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('slot-proof-reconciler', async () => {
    const db = require('../models/db');
    const commitments = require('./call-commitments');
    const callIds = await commitments.listSlotKeptCallIds(db);
    let reopened = 0;
    let failed = 0;
    for (const id of callIds) {
      const r = await commitments.refreshFulfillment(db, id).catch((err) => {
        logger.warn(`[slot-proof-reconciler] refresh failed for call ${id}: ${err.message}`);
        return { failed: 1 };
      });
      reopened += r.reopened || 0;
      failed += r.failed || 0;
    }
    // A lookup that failed left its proof in place: report it to job health.
    if (failed) throw new Error(`Slot proof re-judge incomplete for ${failed} promise(s)`);
    return { checked: callIds.length, reopened };
  });
}

module.exports = { runSlotProofReconciler };
