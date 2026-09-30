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
const { activeFlags, releaseFlag } = require('./outbound-voice/flags');
const { HOLD_FLAG, DISPUTE_REASON_PREFIX } = require('./collection-hold');

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
async function releaseCollectionHold(customerId, { holdId, trx = null } = {}) {
  if (!holdId) return { ok: false, reason: 'hold_id_required' };
  return releaseFlag({ customerId, flag: HOLD_FLAG, id: holdId, trx });
}

module.exports = { listCollectionHolds, releaseCollectionHold };
