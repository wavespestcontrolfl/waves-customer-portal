'use strict';

/**
 * The provider-boundary re-check (dunning consolidation §5 step 9e): the pay
 * page's OWN authority (balance-set.resolveDunnableSet) re-run on the handle
 * the rail's last hook gives us, compared with the set the message was
 * rendered from. Any difference — paid, processing, void, draft, a credit or
 * adjustment, a new live PaymentIntent, a payer statement, a third-party
 * payer, a stop, a pause, an autopay hold, a customer merge — is a retryable
 * refusal, never a partial send (Codex #5188/#5270 class 2: A-1, A-6, A-12,
 * A-13, B-15, B-16). Any throw is the same refusal.
 *
 * The handle matters (A-17): the email authority holds a transaction and
 * DB_POOL_MAX=2 leaves no third connection, so an email/push boundary read
 * must use the `database` it is handed; only the SMS hook runs with no
 * transaction held and reads through the pool.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { resolveDunnableSet } = require('./balance-set');

const SET_CHANGED = 'DUNNING_SET_CHANGED';

const refusal = () => ({
  ok: false,
  code: SET_CHANGED,
  reason: 'The open invoices changed after this reminder was prepared',
  retryable: true,
});

/** What the boundary compares against: identity of the set as rendered. */
const snapshotOf = (customerId, set) => ({
  customerId: String(customerId),
  kind: set.kind,
  digest: set.digest,
  totalCents: set.totalCents,
  anchorId: set.anchor ? set.anchor.id : null,
});

function sameSet(live, snapshot) {
  return !!live && (live.kind === 'multi' || live.kind === 'single')
    && live.kind === snapshot.kind
    && live.digest === snapshot.digest
    && live.totalCents === snapshot.totalCents
    && !!live.anchor && live.anchor.id === snapshot.anchorId;
}

/** @returns {(opts?: { database?: object }) => Promise<{ok: boolean, code?: string, reason?: string, retryable?: boolean}>} */
function check(snapshot) {
  return async ({ database } = {}) => {
    try {
      const live = await resolveDunnableSet(snapshot.customerId, { database: database || db });
      return sameSet(live, snapshot) ? { ok: true } : refusal();
    } catch (err) {
      logger.warn(`[customer-dunning] boundary re-check failed for customer ${snapshot.customerId}: ${err.message}`);
      return refusal();
    }
  };
}

module.exports = { check, snapshotOf, sameSet, SET_CHANGED };
