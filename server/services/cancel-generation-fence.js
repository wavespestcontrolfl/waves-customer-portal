/**
 * The cancellation-generation fence for the Intelligence Bar cancel recovery sweep
 * (services/ib-cancel-effect-bundles.js).
 *
 * The sweep finishes work a dead request left behind: it voids the pinned invoices, takes back the pinned credits,
 * cancels the tracker and the approved linked visits. All of that is right ONLY for the cancellation the card
 * approved. If an operator restored the visit afterwards (a status transition from cancelled back to a live status),
 * voiding its invoice or cancelling it again would damage a live visit. A standalone re-read before the work is not
 * enough, so every mutation of the sweep calls assertCancelGeneration INSIDE its own transaction, right before it
 * writes:
 *
 *   - It takes `FOR SHARE NOWAIT` on the visit row. A restore is an UPDATE of that row (transitionJobStatus), which
 *     conflicts with the share lock: either the restore committed first (the status read below sees it) or it waits for
 *     this short transaction. A restore in flight (row already locked) makes this fail at once with 'visit_busy'
 *     instead of waiting, so the lock order against the invoice, offer and child locks the callers already hold can
 *     never deadlock. The sweep retries a busy visit on its next pass.
 *   - Under the lock the visit must still be 'cancelled' and no transition to any other status may have been written
 *     after the bundle (the original cancellation) was written. A cancelled, restored and cancelled-again visit has such
 *     a transition, so a different cancel is never mistaken for the approved one.
 *
 * Every failure is also pushed to `fence.hits`, so the sweep learns that a mutation was refused even though the
 * helpers it calls swallow errors and report skips. Callers that pass no fence are unchanged.
 */
class CancelFenceError extends Error {
  constructor(reason) {
    super(`cancellation fence: ${reason}`);
    this.name = 'CancelFenceError';
    this.code = 'CANCEL_FENCE';
    this.fenceReason = reason;
  }
}

/**
 * @param {Function} conn  A knex instance or transaction. On a transaction the share lock lasts until it ends; on the
 *   plain pool it is only a point-in-time check (use that for pre-checks, never as the guard of a write).
 * @param {{ visitId: string, since: Date, hits: string[] }|null} fence
 */
async function assertCancelGeneration(conn, fence) {
  if (!fence) return;
  const fail = (reason) => {
    fence.hits.push(reason);
    throw new CancelFenceError(reason);
  };
  let row;
  try {
    row = await conn('scheduled_services').where({ id: fence.visitId }).forShare().noWait().first('status');
  } catch (err) {
    if (err && err.code === '55P03') fail('visit_busy');
    throw err;
  }
  if (!row) fail('visit_missing');
  if (String(row.status) !== 'cancelled') fail(`visit_is_${row.status}`);
  const later = await conn('job_status_history')
    .where({ job_id: fence.visitId })
    .whereNot('to_status', 'cancelled')
    .where('transitioned_at', '>', fence.since)
    .first('id');
  if (later) fail('visit_restored_since');
}

const isCancelFence = (err) => Boolean(err) && err.code === 'CANCEL_FENCE';

module.exports = { CancelFenceError, assertCancelGeneration, isCancelFence };
