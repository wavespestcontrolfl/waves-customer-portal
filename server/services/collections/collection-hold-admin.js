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
      flag: r.flag,
      reason: r.reason || null,
      created_by: r.created_by || null,
      created_at: r.created_at,
      // Only a dispute hold stops charges; fallback holds only pause outreach.
      stops_charges: String(r.reason || '').toLowerCase().startsWith(DISPUTE_REASON_PREFIX),
    }));
}

async function releaseCollectionHold(customerId) {
  const res = await releaseFlag({ customerId, flag: HOLD_FLAG });
  return res;
}

module.exports = { listCollectionHolds, releaseCollectionHold };
