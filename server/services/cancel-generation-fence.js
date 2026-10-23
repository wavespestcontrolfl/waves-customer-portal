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
 *     conflicts with the share lock: either the restore committed first (the checks below see it) or it waits for this
 *     short transaction. A restore in flight (row already locked) makes this fail at once with 'visit_busy' instead of
 *     waiting, so the lock order against the invoice, offer and child locks the callers already hold can never deadlock.
 *     The sweep retries a busy visit on its next pass.
 *   - Under the lock the visit must still be 'cancelled' AND its restoration count must equal the one the cancel
 *     transaction pinned in the bundle (`fence.restorations`). The count is of job_status_history rows that leave
 *     'cancelled' for another status. The table is append-only and a restore inserts its row in the same transaction as
 *     its status UPDATE (which holds the visit row lock), so under our share lock the count is exact. NO TIME IS
 *     COMPARED: job_status_history.transitioned_at defaults to the transaction START time, so a restoration that began
 *     before the bundle was written but committed after it carries an earlier timestamp. A cancel -> restore -> cancel
 *     again sequence always raises the count (a re-cancel needs a restoration first), so a different cancel is never
 *     mistaken for the approved one.
 *
 * OWNERSHIP. The same fence also proves the sweep still OWNS the bundle it works for (`fence.bundleId` + `fence.leaseToken`, set
 * by the recovery sweep only). A runner that paused past its lease (another worker claimed or finished the bundle, or the bundle
 * expired and the office was told nothing more would run) must not act: before the visit check, in the same transaction as the
 * effect, the bundle row is taken `FOR SHARE NOWAIT` and must be status 'pending', lease_owner = the token and lease_until in the
 * future, else the effect is refused with 'lease_lost' (nothing is written, exactly like a restore). Lock order, everywhere: any
 * row the caller already holds -> BUNDLE row (share, nowait) -> VISIT row (share, nowait). finalizeOwned takes the bundle row
 * FOR UPDATE first and the visit share lock second, the same order; both of the fence's locks are NOWAIT, so no cycle can wait.
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

/** How many times the visit has left 'cancelled' for another status (append-only, so it only grows). */
async function countRestorations(conn, visitId) {
  const row = await conn('job_status_history')
    .where({ job_id: visitId, from_status: 'cancelled' })
    .whereNot('to_status', 'cancelled')
    .count({ n: '*' })
    .first();
  return Number(row && row.n) || 0;
}

/**
 * @param {Function} conn  A knex instance or transaction. On a transaction the share lock lasts until it ends; on the
 *   plain pool it is only a point-in-time check (use that for pre-checks, never as the guard of a write).
 * @param {{ visitId: string, restorations: number, hits: string[] }|null} fence  `restorations` is the count pinned by
 *   the cancel transaction (bundle.restorations_seen).
 */
async function assertCancelGeneration(conn, fence) {
  if (!fence) return;
  const fail = (reason) => {
    fence.hits.push(reason);
    throw new CancelFenceError(reason);
  };
  if (fence.bundleId) await assertBundleLease(conn, fence, fail);
  let row;
  try {
    row = await conn('scheduled_services').where({ id: fence.visitId }).forShare().noWait().first('status');
  } catch (err) {
    if (err && err.code === '55P03') fail('visit_busy');
    throw err;
  }
  if (!row) fail('visit_missing');
  if (String(row.status) !== 'cancelled') fail(`visit_is_${row.status}`);
  if ((await countRestorations(conn, fence.visitId)) !== Number(fence.restorations)) fail('visit_restored_since');
}

// The sweep still owns its bundle: the row is locked FOR SHARE NOWAIT (an owner/lease update in flight is 'bundle_busy', a retry)
// and must be pending, held by this runner's token, with a lease that has not run out (judged on the database clock).
async function assertBundleLease(conn, fence, fail) {
  let row;
  try {
    row = await conn('ib_cancel_effect_bundles').where({ id: fence.bundleId }).forShare().noWait()
      .first('status', 'lease_owner', conn.raw('(lease_until > now()) AS lease_live'));
  } catch (err) {
    if (err && err.code === '55P03') fail('bundle_busy');
    throw err;
  }
  if (!row || row.status !== 'pending' || row.lease_owner !== fence.leaseToken || row.lease_live !== true) fail('lease_lost');
}

const isCancelFence = (err) => Boolean(err) && err.code === 'CANCEL_FENCE';

module.exports = { CancelFenceError, assertCancelGeneration, countRestorations, isCancelFence };
