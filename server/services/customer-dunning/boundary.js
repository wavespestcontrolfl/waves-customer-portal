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
 * The SCHEDULE is re-read too (the set authority reads invoice membership, not
 * schedule state): an admin pause / release / close after the claim leaves the
 * set unchanged, so the boundary must see the row itself. It must still be
 * open (active/held) and still carry THIS run's claim stamp. On a handed
 * transaction the row is read FOR UPDATE, so a control write (an UPDATE of the
 * same row) waits for the dispatch to finish instead of interleaving with it;
 * the SMS hook holds no transaction and reads through the pool (a control write
 * landing between that read and the provider call is the window every send has).
 *
 * The CUSTOMER is re-read as well: an archived (deleted_at) or missing customer is a non-retryable refusal
 * (DUNNING_CUSTOMER_DELETED), and the runner pauses the schedule customer_deleted, as decideCustomer does.
 *
 * A collections HOLD is re-read as well (the messaging rails gate this sender's entry point, and this is
 * the same check on the handle the hook is given, so a hold landing during rendering or provider preparation
 * stops every leg, the operator handoff included).
 *
 * The handle matters (A-17): the email authority holds a transaction and
 * DB_POOL_MAX=2 leaves no third connection, so an email/push boundary read
 * must use the `database` it is handed; only the SMS hook runs with no
 * transaction held and reads through the pool.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const { resolveDunnableSet } = require('./balance-set');
const collectionHold = require('../collections/collection-hold');

const SET_CHANGED = 'DUNNING_SET_CHANGED';
const SCHEDULE_CHANGED = 'DUNNING_SCHEDULE_CHANGED';
const CUSTOMER_DELETED = 'DUNNING_CUSTOMER_DELETED';
const SCHEDULE_TABLE = 'customer_dunning_schedules';
const SENDABLE_STATUSES = ['active', 'held'];

const refusal = () => ({
  ok: false,
  code: SET_CHANGED,
  reason: 'The open invoices changed after this reminder was prepared',
  retryable: true,
});

const scheduleRefusal = () => ({
  ok: false,
  code: SCHEDULE_CHANGED,
  reason: 'The reminder schedule was paused, released or taken over after this reminder was prepared',
  retryable: true,
});

// Staff archive a customer by stamping customers.deleted_at; nothing else about the schedule or the open
// invoices changes, so the boundary reads the customer itself. Not retryable: the runner pauses the schedule.
const customerDeletedRefusal = () => ({
  ok: false,
  code: CUSTOMER_DELETED,
  reason: 'The customer was archived after this reminder was prepared',
  retryable: false,
});

/**
 * What the boundary compares against: identity of the set as rendered, plus
 * (when given) the schedule row and claim stamp this send runs under.
 */
const snapshotOf = (customerId, set, { scheduleId = null, claimStamp = null, operatorInitiated = false } = {}) => ({
  operatorInitiated: operatorInitiated === true,
  scheduleId: scheduleId == null ? null : String(scheduleId),
  claimStamp: claimStamp == null ? null : new Date(claimStamp).getTime(),
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

async function customerArchived(customerId, database) {
  const row = await database('customers').where({ id: customerId }).first('id', 'deleted_at');
  return !row || !!row.deleted_at;
}

/** Still open, and still claimed by THIS run (see the header). Locks the row on a transaction. */
async function scheduleStillOurs(snapshot, database) {
  const query = database(SCHEDULE_TABLE).where({ id: snapshot.scheduleId }).select('status', 'touch_claimed_at');
  if (database.isTransaction) query.forUpdate();
  const row = await query.first();
  return !!row && SENDABLE_STATUSES.includes(row.status)
    && !!row.touch_claimed_at && new Date(row.touch_claimed_at).getTime() === snapshot.claimStamp;
}

/**
 * A hook that holds a transaction (email authority, push, the operator handoff) passes
 * it as `database`; the SMS pre-dispatch hook holds none and reads through the pool.
 * @returns {(opts?: { database?: object }) => Promise<{ok: boolean, code?: string, reason?: string, retryable?: boolean}>}
 */
function check(snapshot) {
  return async ({ database } = {}) => {
    const handle = database || db;
    try {
      if (snapshot.scheduleId && !await scheduleStillOurs(snapshot, handle)) return scheduleRefusal();
      if (await customerArchived(snapshot.customerId, handle)) return customerDeletedRefusal();
      // A collections hold (dispute, or the wrong-number / wrong-party fallback) committed after the policy
      // consult stops the notice here too: the WAIT outcome every rail reads as a hold, never a failure.
      // An operator's deliberate send skips a plain dispute hold only; a fallback hold still waits.
      const held = await collectionHold.messagingHeldByCollectionHold(snapshot.customerId, handle, { ignoreDisputeHold: snapshot.operatorInitiated === true });
      if (held.held) return { ok: false, ...collectionHold.holdDeferOutcome(held) };
      const live = await resolveDunnableSet(snapshot.customerId, { database: handle });
      return sameSet(live, snapshot) ? { ok: true } : refusal();
    } catch (err) {
      logger.warn(`[customer-dunning] boundary re-check failed for customer ${snapshot.customerId}: ${redactContact(err.message)}`);
      return refusal();
    }
  };
}

module.exports = { check, snapshotOf, sameSet, SET_CHANGED, SCHEDULE_CHANGED, CUSTOMER_DELETED };
