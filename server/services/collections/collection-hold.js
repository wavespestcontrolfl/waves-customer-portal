/**
 * Active DISPUTE hold (collections_flags collection_hold) as a money-movement
 * stop.
 *
 * A dispute raised on a collections voice call writes a customer-level
 * `collection_hold` flag (outbound-voice/flags.js placeDisputeHold) and tells
 * the customer "all billing follow-up is on hold". Every OFF-SESSION charge
 * primitive (StripeService.charge, chargeInvoiceWithSavedCard,
 * chargeSavedPaymentMethodOffSession) checks it by DEFAULT and refuses before
 * any Stripe call; a customer- or operator-initiated caller opts out
 * explicitly (`customerInitiated` / `operatorOverride`). The completion
 * balance sweep and pay-combined also fold it into "dunning stopped"
 * (completion-balance-sweep.dunningStoppedInvoiceIds).
 *
 * ONLY dispute holds stop money. collection_hold is also written as a
 * fallback ARTIFACT when a wrong-number / wrong-party report could not be
 * filed (collections-conversation.js) — those rows mean "pause outreach",
 * not "don't charge the saved card", so they must not stop a charge. The
 * discriminator is the row's reason text: placeDisputeHold writes
 * `dispute on call: <summary>` or `dispute raised on call`
 * (DISPUTE_REASON_PREFIX), the fallbacks write `wrong-number report ...` /
 * `wrong-party answer ...`. Rows written before this change carry the same
 * strings, so no backfill or migration is needed. A dispute raised while a
 * fallback hold is already active upgrades that row's reason (flags.js), so
 * the one-active-row-per-flag index can never hide a dispute.
 *
 * The flag row is the single source of truth: an unreleased row
 * (released_at IS NULL) holds; releaseFlag stamps released_at and every
 * lane resumes on its next attempt. There is deliberately NO cross-writer
 * locking: the hold writer must never wait on, or fail because of, a charge
 * in flight. A charge sees every hold that committed before its check; a
 * hold committing in the milliseconds after the check races the charge
 * exactly like a dispute call landing just after the card was charged.
 *
 * Refusal codes (both thrown BEFORE any Stripe call, both RETRYABLE):
 *   COLLECTION_HOLD_ACTIVE        a dispute hold is active
 *   COLLECTION_HOLD_CHECK_FAILED  the lookup itself failed (fail closed)
 * Callers must treat them as "not attempted, retry after release": never a
 * decline, a payer refusal or a handled outcome, and never a payment-failed
 * message or pay link.
 */

const db = require('../../models/db');

const HOLD_FLAG = 'collection_hold';
const DISPUTE_REASON_PREFIX = 'dispute';
const HOLD_ACTIVE_CODE = 'COLLECTION_HOLD_ACTIVE';
const HOLD_CHECK_FAILED_CODE = 'COLLECTION_HOLD_CHECK_FAILED';
// In-memory twin of activeDisputeHolds' reason predicate (case-insensitive
// prefix; ILIKE in SQL).
const isDisputeHoldReason = (reason) => String(reason || '').toLowerCase().startsWith(DISPUTE_REASON_PREFIX);
// A dispute that lands on an ACTIVE fallback hold (wrong number / wrong party) shares its
// row (one active row per customer+flag), so the row is upgraded to the dispute reason and
// the fallback's own reason rides at the END, inside a fixed trailer:
//     <dispute reason> [earlier hold: <fallback reason>]
// Releasing the dispute must put the fallback BACK (the row stays active), never stamp
// released_at, or the all-channel outreach block the fallback carried would silently drop.
// priorHoldReasonOf is the one reader of the trailer; embedPriorHoldReason the one writer
// (SQL twin: embedPriorHoldReasonSql in outbound-voice/flags.js). No column, no migration.
const PRIOR_HOLD_OPEN = ' [earlier hold: ';
const PRIOR_HOLD_CLOSE = ']';
const DISPUTE_TEXT_CAP = 300; // the dispute part is trimmed so the fallback trailer always fits intact

function embedPriorHoldReason(disputeReason, priorReason) {
  const prior = String(priorReason == null ? '' : priorReason).trim();
  return `${String(disputeReason).slice(0, DISPUTE_TEXT_CAP)}${PRIOR_HOLD_OPEN}${prior}${PRIOR_HOLD_CLOSE}`;
}

// null: this is a plain dispute hold (nothing to restore). Otherwise { prior } where prior
// is the fallback's original reason text, or null when it had none.
function priorHoldReasonOf(reason) {
  const text = String(reason || '');
  if (!isDisputeHoldReason(text) || !text.endsWith(PRIOR_HOLD_CLOSE)) return null;
  const at = text.lastIndexOf(PRIOR_HOLD_OPEN);
  if (at < 0) return null;
  const prior = text.slice(at + PRIOR_HOLD_OPEN.length, text.length - PRIOR_HOLD_CLOSE.length).trim();
  return { prior: prior || null };
}

// The dispute part of a reason, trailer removed (a reason with no trailer is returned as is).
function withoutPriorHoldReason(reason) {
  const text = String(reason || '');
  return priorHoldReasonOf(text) ? text.slice(0, text.lastIndexOf(PRIOR_HOLD_OPEN)) : text;
}

const isCollectionHoldRefusal = (err) => err?.code === HOLD_ACTIVE_CODE || err?.code === HOLD_CHECK_FAILED_CODE;

// Restrict a collections_flags query to ACTIVE DISPUTE holds.
function activeDisputeHolds(query) {
  return query
    .where({ flag: HOLD_FLAG })
    .whereNull('released_at')
    .whereRaw('reason ILIKE ?', [`${DISPUTE_REASON_PREFIX}%`]);
}

// The same discriminator as a correlated EXISTS body for queries that join
// through their own alias (termite grace-lapse scans): `this` is the
// whereExists/whereNotExists builder and `outerCustomerColumn` e.g. 'tt.customer_id'.
function disputeHoldExistsSql(builder, outerCustomerColumn) {
  return builder.select(1).from('collections_flags as f')
    .whereRaw('f.customer_id = ??', [outerCustomerColumn])
    .where('f.flag', HOLD_FLAG)
    .whereNull('f.released_at')
    .whereRaw('f.reason ILIKE ?', [`${DISPUTE_REASON_PREFIX}%`]);
}

async function customerHasActiveCollectionHold(customerId, database = db) {
  if (!customerId) return false;
  const row = await activeDisputeHolds(database('collections_flags').where({ customer_id: customerId })).first('id');
  return !!row;
}

// Same answer, but a lookup failure throws COLLECTION_HOLD_CHECK_FAILED
// (fail closed, retryable) instead of the raw DB error.
async function customerHasActiveCollectionHoldChecked(customerId, database = db) {
  try {
    return await customerHasActiveCollectionHold(customerId, database);
  } catch (err) {
    throw Object.assign(new Error(`Collection hold could not be verified (${err.message}). Review before charging.`), {
      code: HOLD_CHECK_FAILED_CODE,
      cause: err,
    });
  }
}

// The default-on guard the off-session charge primitives call. Throws the
// coded refusal; returns nothing when clear.
async function assertNoCollectionHold(customerId, database = db) {
  if (await customerHasActiveCollectionHoldChecked(customerId, database)) {
    throw Object.assign(new Error('Collection is on hold for this customer (billing dispute). Review before charging.'), {
      code: HOLD_ACTIVE_CODE,
    });
  }
}

// Set of (stringified) invoice ids whose customer has an active dispute hold.
async function collectionHoldInvoiceIds(invoiceIds, { database = db } = {}) {
  if (!invoiceIds || !invoiceIds.length) return new Set();
  const invoices = await database('invoices')
    .whereIn('id', invoiceIds)
    .select('id', 'customer_id');
  const customerIds = [...new Set(invoices.map((r) => r.customer_id).filter(Boolean).map(String))];
  if (!customerIds.length) return new Set();
  const flags = await activeDisputeHolds(database('collections_flags').whereIn('customer_id', customerIds))
    .select('customer_id');
  const held = new Set(flags.map((r) => String(r.customer_id)));
  return new Set(invoices.filter((r) => r.customer_id && held.has(String(r.customer_id))).map((r) => String(r.id)));
}

// An operator-ordered charge (operatorOverride) goes past an active dispute
// hold. It is never blocked, but it must leave a trail: an audit row naming the
// admin and a distinct autopay event. The charge primitives call this AT the
// charge boundary (the same place the default guard would have refused), so a
// hold that lands between the route and the charge is still attributed.
// `database` is the transaction the primitive already holds. Best-effort - a
// failed lookup or write only logs, it never blocks or fails the charge.
async function recordHoldOverride({ customerId, actorId = null, ip = null, userAgent = null, route = null, invoiceId = null, database = db }) {
  const args = { customerId, actorId, ip, userAgent, route, invoiceId };
  try {
    // Inside the charge transaction a failed read would abort the whole trx
    // (25P02) and block the charge this trail only annotates, so the lookup
    // runs under a savepoint that rolls back on error.
    return database.isTransaction
      ? await database.transaction((sp) => recordHoldOverrideOn(sp, args))
      : await recordHoldOverrideOn(database, args);
  } catch (err) {
    require('../logger').warn(`[collection-hold] override trail failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

async function recordHoldOverrideOn(database, { customerId, actorId, ip, userAgent, route, invoiceId }) {
  if (!(await customerHasActiveCollectionHold(customerId, database))) return false;
  const { recordAuditEvent } = require('../audit-log');
  const { logAutopay } = require('../autopay-log');
  await recordAuditEvent({
    actor_type: 'technician',
    actor_id: actorId,
    action: 'customer.collection_hold_overridden',
    resource_type: 'customer',
    resource_id: customerId,
    metadata: { route, invoice_id: invoiceId },
    ip_address: ip,
    user_agent: userAgent,
    critical: false,
  });
  await logAutopay(customerId, 'collection_hold_overridden', { details: { route, invoice_id: invoiceId, admin_id: actorId } });
  return true;
}

// ── Never-attempted hold deferrals ──────────────────────────────────────
// The monthly dues cron, on an active dispute hold, writes a payments row
// with status 'failed' and metadata.deferred_reason = 'collection_hold' (no
// PI, retry_count 0, next_retry_at armed) purely so the retry sweep collects
// the month after release. Stripe was NEVER contacted: nothing failed, no
// card was declined. Every consumer that counts unsuperseded 'failed'
// payments as payment failures (balance, billing health, dashboard alerts,
// lead score, health/risk signals) must leave these rows out, exactly like
// the balance endpoint always did. ONE definition, in two shapes:
//   isNeverAttemptedHoldDeferral(row)             in-memory row filter
//   excludeNeverAttemptedHoldDeferrals(qb, alias) SQL twin for query builders
// Only while ARMED and never-attempted: once the sweep disarms the row
// without superseding, or a real attempt bumps retry_count / stamps a PI,
// it is visible debt like any other failed row.
const HOLD_DEFERRAL_REASON = 'collection_hold';

function isNeverAttemptedHoldDeferral(p) {
  if (!p || p.stripe_payment_intent_id || Number(p.retry_count || 0) > 0 || p.next_retry_at == null) return false;
  try {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
    return !!(m && m.deferred_reason === HOLD_DEFERRAL_REASON);
  } catch {
    return false;
  }
}

// `alias` is the payments table name/alias in the calling query. COALESCE
// keeps the NOT() NULL-safe for rows with no metadata.
function excludeNeverAttemptedHoldDeferrals(query, alias = 'payments') {
  return query.whereRaw(
    `NOT (COALESCE(${alias}.metadata->>'deferred_reason', '') = ? AND ${alias}.stripe_payment_intent_id IS NULL AND COALESCE(${alias}.retry_count, 0) = 0 AND ${alias}.next_retry_at IS NOT NULL)`,
    [HOLD_DEFERRAL_REASON],
  );
}

// Customer-facing payment HISTORY (portal): the hold-deferral placeholder is not a payment
// at any point of its life. While armed it is never-attempted (above); once the retry sweep
// collects it, the retry inserts its OWN paid row and the placeholder is left 'failed' with
// superseded_by_payment_id pointing at that row (retry_count bumped, next_retry_at cleared) -
// it must not surface then either, or a collected month reads as FAILED with "Update Payment
// Method". Superseded by ITS OWN id is the orphan-charge marker (charged at Stripe, ledger
// row missing) and stays visible, like any disarmed row that nothing replaced.
function excludeHoldDeferralPlaceholders(query, alias = 'payments') {
  return query.whereRaw(
    `NOT (COALESCE(${alias}.metadata->>'deferred_reason', '') = ? AND ${alias}.stripe_payment_intent_id IS NULL AND ((COALESCE(${alias}.retry_count, 0) = 0 AND ${alias}.next_retry_at IS NOT NULL) OR (${alias}.superseded_by_payment_id IS NOT NULL AND ${alias}.superseded_by_payment_id <> ${alias}.id)))`,
    [HOLD_DEFERRAL_REASON],
  );
}

module.exports = {
  isNeverAttemptedHoldDeferral,
  excludeHoldDeferralPlaceholders,
  excludeNeverAttemptedHoldDeferrals,
  HOLD_DEFERRAL_REASON,
  PRIOR_HOLD_OPEN,
  PRIOR_HOLD_CLOSE,
  DISPUTE_TEXT_CAP,
  embedPriorHoldReason,
  priorHoldReasonOf,
  withoutPriorHoldReason,
  recordHoldOverride,
  activeDisputeHolds,
  disputeHoldExistsSql,
  HOLD_FLAG,
  DISPUTE_REASON_PREFIX,
  HOLD_ACTIVE_CODE,
  HOLD_CHECK_FAILED_CODE,
  isCollectionHoldRefusal,
  isDisputeHoldReason,
  customerHasActiveCollectionHold,
  customerHasActiveCollectionHoldChecked,
  assertNoCollectionHold,
  collectionHoldInvoiceIds,
};
