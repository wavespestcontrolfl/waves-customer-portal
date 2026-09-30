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
 */
const db = require('../../models/db');
const logger = require('../logger');
const { activeFlags, releaseFlag } = require('./outbound-voice/flags');
const { HOLD_FLAG, DISPUTE_REASON_PREFIX, priorHoldReasonOf, isDisputeHoldReason } = require('./collection-hold');

async function listCollectionHolds(customerId) {
  const rows = await activeFlags(customerId);
  return rows
    .filter((r) => r.flag === HOLD_FLAG)
    .map((r) => ({
      // The row id: a release names exactly the hold staff were looking at.
      id: r.id,
      flag: r.flag,
      reason: r.reason || null,
      created_by: r.created_by || null,
      created_at: r.created_at,
      // Only a dispute hold stops charges; fallback holds only pause outreach.
      stops_charges: String(r.reason || '').toLowerCase().startsWith(DISPUTE_REASON_PREFIX),
    }));
}

// Releases exactly ONE hold row: `holdId` from listCollectionHolds, and only
// while that row is still active and belongs to this customer. released: 0
// means the hold changed since staff loaded it (already released, replaced by a
// newer hold, or no longer a dispute) — the caller reports a conflict, never a
// blind release of whatever hold is active now.
//
// A dispute that was raised on top of an ACTIVE wrong-number / wrong-party
// fallback hold shares that row (one active row per customer+flag), with the
// fallback's reason kept in a trailer (collection-hold.js). Releasing the DISPUTE
// must not lift the fallback's all-channel outreach block, so the dispute row is
// released (released_at stamped, its id retired) and the fallback is written back
// as a NEW active row with its original reason, actor and time
// (`fallbackRestored: true`). A NEW id matters: a stale screen, a repeated request
// or a later dispute on the restored fallback can never release the wrong episode,
// because a holdId names exactly one dispute and dies with its release (released: 0,
// the route's 409). `released` counts the dispute, so charging resumes exactly as
// for a plain dispute hold.
async function releaseCollectionHold(customerId, { holdId, trx = null } = {}) {
  if (!holdId) return { ok: false, reason: 'hold_id_required' };
  const run = async (t) => {
    const row = await t('collections_flags')
      .where({ id: holdId, customer_id: customerId, flag: HOLD_FLAG })
      .whereNull('released_at')
      .forUpdate()
      .first('id', 'reason', 'created_by', 'created_at');
    if (!row) return { ok: true, released: 0 };
    // Only a DISPUTE hold is released here (that is all the office is shown a Release for):
    // a fallback hold's id must never lift it. released: 0 is the caller's 409 "hold changed".
    if (!isDisputeHoldReason(row.reason)) return { ok: true, released: 0 };
    const restore = priorHoldReasonOf(row.reason);
    const released = await releaseFlag({ customerId, flag: HOLD_FLAG, id: holdId, trx: t });
    if (!restore || !released.ok || released.released < 1) return released;
    // The dispute row is released; put the fallback back as a fresh active row. ON CONFLICT
    // DO NOTHING: if another writer already placed an active hold in this instant, that hold
    // stands and there is nothing to restore (no failed statement inside the transaction).
    await t.raw(
      `INSERT INTO collections_flags (customer_id, flag, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (customer_id, flag) WHERE released_at IS NULL DO NOTHING`,
      [customerId, HOLD_FLAG, restore.prior, row.created_by || null, row.created_at],
    );
    return { ok: true, released: 1, fallbackRestored: true };
  };
  try {
    return trx ? await run(trx) : await db.transaction(run);
  } catch (err) {
    logger.error(`[collection-hold-admin] release FAILED customer=${customerId} hold=${holdId}: ${err.message}`);
    return { ok: false, reason: 'release_failed' };
  }
}

module.exports = { listCollectionHolds, releaseCollectionHold };
