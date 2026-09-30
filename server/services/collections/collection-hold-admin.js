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
const { HOLD_FLAG, DISPUTE_REASON_PREFIX, priorHoldReasonOf } = require('./collection-hold');

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
// means the hold changed since staff loaded it (already released, or replaced
// by a newer hold) — the caller reports a conflict, never a blind release of
// whatever hold is active now.
//
// A dispute that was raised on top of an ACTIVE wrong-number / wrong-party
// fallback hold shares that one row (one active row per customer+flag), with the
// fallback's reason kept in a trailer (collection-hold.js). Releasing the DISPUTE
// must not lift the fallback's all-channel outreach block: the row is downgraded
// back to the fallback reason and stays active (released_at untouched), and the
// result says so (`fallbackRestored: true`). `released` still counts the dispute
// as released, so charging resumes exactly as for a plain dispute hold.
async function releaseCollectionHold(customerId, { holdId, trx = null } = {}) {
  if (!holdId) return { ok: false, reason: 'hold_id_required' };
  const run = async (t) => {
    const row = await t('collections_flags')
      .where({ id: holdId, customer_id: customerId, flag: HOLD_FLAG })
      .whereNull('released_at')
      .forUpdate()
      .first('id', 'reason');
    if (!row) return { ok: true, released: 0 };
    const restore = priorHoldReasonOf(row.reason);
    if (!restore) return releaseFlag({ customerId, flag: HOLD_FLAG, id: holdId, trx: t });
    await t('collections_flags').where({ id: holdId }).update({ reason: restore.prior });
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
