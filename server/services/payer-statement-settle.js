/**
 * Third-party Payer Phase 2 — P3 (pay + settle): statement settlement + the
 * status state machine shared by the pay flow, the Stripe webhook, and admin
 * reconcile.
 *
 *   open → finalized → sent → viewed → processing → paid   (or → void)
 *
 * - PAYABLE statuses (`finalized`/`sent`/`viewed`) are frozen and not-in-flight:
 *   a PaymentIntent may be created from one of these. `open` (accruing), `void`,
 *   `paid`, and `processing` (a confirmed payment in flight) must be refused.
 * - `processing` is entered ONLY on a CONFIRMED money-in-flight webhook (ACH
 *   `payment_intent.processing` / card `succeeded`), never on PI creation — an
 *   unconfirmed PI stays replaceable. Once `processing`, a second pay confirm AND
 *   admin reconcile are both refused.
 * - `overdue` is DERIVED from `due_date`, never a stored status; a past-due
 *   statement is still one of the payable statuses.
 *
 * Settlement CASCADES: paying a statement settles every accrued child invoice on
 * it atomically (one statement → one `payments` row → many invoices marked paid
 * with `paid_at = statement.paid_at`, a settlement marker, not N card charges).
 *
 * Design: docs/design/payer-net-statements-plan.md (Payment / reconciliation /
 * webhook + Cascade-on-settle).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// Frozen + not-in-flight: a PaymentIntent may be created from these.
const PAYABLE_STATEMENT_STATUSES = new Set(['finalized', 'sent', 'viewed']);
// Settle-to-paid is allowed from a payable status OR from `processing`
// (ACH that confirmed, or a card that went straight to succeeded). Never from
// `open` / `void` / `paid`.
const SETTLEABLE_STATEMENT_STATUSES = new Set(['finalized', 'sent', 'viewed', 'processing']);

const isPayableStatementStatus = (status) => PAYABLE_STATEMENT_STATUSES.has(status);

/**
 * The payable status a statement falls back to when its payment fails/cancels —
 * the latest delivery state it actually reached, derived from its timestamps. We
 * never store a "prior status"; viewed_at / sent_at / finalized_at are the truth.
 */
function priorPayableStatus(stmt) {
  if (stmt?.viewed_at) return 'viewed';
  if (stmt?.sent_at) return 'sent';
  return 'finalized';
}

/**
 * Serialize ALL statement money mutations (settle / dispute / refund) on a
 * per-statement advisory lock so out-of-order Stripe webhook events can't race
 * each other (TOCTOU on the existence/state of the settlement row). Runs `fn(trx)`
 * inside a transaction that holds the lock; `settleStatementPaid` takes the SAME
 * lock, so a settlement and a dispute/refund for the same statement are
 * strictly serialized and each re-reads state under the lock.
 */
async function withStatementMoneyLock(statementId, fn, { database = db } = {}) {
  const run = async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['payer.statement.money', String(statementId)]);
    return fn(trx);
  };
  return database === db ? db.transaction(run) : run(database);
}

/**
 * Cascade-settle a statement to `paid`. MUST run inside the caller's transaction
 * (webhook or admin reconcile). Idempotent: a statement already `paid` is a
 * no-op (duplicate/late webhook). Throws if settled from a non-settleable status.
 *
 * `settlement.amountCents` = the CHARGED total (surcharged for a card; bare total
 * for ACH/offline). The base/surcharge split rides the `*_cents` columns.
 */
async function settleStatementPaid(statementId, settlement = {}, { database = db, allowedStatuses = SETTLEABLE_STATEMENT_STATUSES } = {}) {
  // Serialize against concurrent/out-of-order dispute & refund events on the same
  // statement (they take the same advisory lock) — see withStatementMoneyLock.
  await database.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['payer.statement.money', String(statementId)]);
  const stmt = await database('payer_statements').where({ id: statementId }).forUpdate().first();
  if (!stmt) throw new Error(`settleStatementPaid: statement ${statementId} not found`);
  if (stmt.status === 'paid') {
    // A REDELIVERY must be able to finish what the first delivery started
    // (Codex #4311 r30 P1): if enrollment (and its recovery marker) failed
    // after the settlement committed, the only way back is this idempotent
    // path, so it reports the packet-owned children too. enrollForPaidInvoice
    // is idempotent, so re-running it on already-enrolled children is a
    // no-op.
    const settledChildren = await database('invoices')
      .where({ payer_statement_id: statementId })
      .whereNotNull('visit_completion_packet_id')
      .whereNot({ status: 'void' })
      .pluck('id');
    return { ok: true, alreadyPaid: true, statement: stmt, packetInvoiceIds: settledChildren };
  }
  // Webhook settles from any payable status OR `processing` (ACH confirmed);
  // an offline reconcile passes the PAYABLE-only set so it can't settle a
  // statement whose online payment is already in flight (double collection).
  if (!allowedStatuses.has(stmt.status)) {
    const err = new Error(`statement ${statementId} not settleable from '${stmt.status}'`);
    err.statusCode = (stmt.status === 'processing') ? 409 : 400;
    throw err;
  }

  const {
    paymentMethod = 'offline',
    processor = null,
    stripePaymentIntentId = null,
    stripeChargeId = null,
    amountCents,
    baseAmountCents = null,
    surchargeAmountCents = 0,
    surchargeRateBps = 0,
    surchargePolicyVersion = null,
    cardFunding = null,
    cardBrand = null,
    // Settlement moment when the caller knows it (the webhook passes
    // Stripe's event timestamp); payment_date buckets P&L revenue, so
    // defaulting to handler-run time would let a delayed/retried webhook
    // move statement cash across a period boundary.
    settledAt = null,
    source = 'unknown',
  } = settlement;

  if (!Number.isFinite(amountCents)) throw new Error('settleStatementPaid: numeric amountCents required');

  // One settlement timestamp shared by the statement AND its children so a child's
  // paid_at is a true settlement marker (= statement.paid_at), not a per-row clock.
  const paidAt = new Date();

  await database('payer_statements').where({ id: statementId }).update({
    status: 'paid',
    paid_at: paidAt,
    payment_method: paymentMethod,
    stripe_charge_id: stripeChargeId || stmt.stripe_charge_id || null,
    stripe_payment_intent_id: stripePaymentIntentId || stmt.stripe_payment_intent_id || null,
    updated_at: paidAt,
  });

  // Cascade — accrued children are `draft`; settle every non-void/non-paid one.
  // The packet-owned children are captured BEFORE the update: a review the
  // closeout deferred behind an unpaid invoice is enrolled by the settlement
  // signal, and this rail (NET statement payment) never sent one (Codex
  // #4311 r29 P1). After the update those rows are indistinguishable from
  // children settled by an earlier statement run.
  const packetChildren = await database('invoices')
    .where({ payer_statement_id: statementId })
    .whereNotIn('status', ['void', 'paid'])
    .whereNotNull('visit_completion_packet_id')
    .select('id', 'invoice_number', 'customer_id', 'visit_completion_packet_id');
  const childrenSettled = await database('invoices')
    .where({ payer_statement_id: statementId })
    .whereNotIn('status', ['void', 'paid'])
    .update({ status: 'paid', paid_at: paidAt, updated_at: paidAt });

  // ONE payer-scoped ledger row (customer_id NULL — a statement spans many homes).
  // UPSERT on the PI: an out-of-order dispute.closed can pre-write a durable
  // marker row for this PI; settling must CONSUME it (update), not insert a
  // duplicate. Merge any existing dispute_final marker into the metadata.
  const existingRow = stripePaymentIntentId
    ? await database('payments').where({ stripe_payment_intent_id: stripePaymentIntentId, statement_id: statementId }).first()
    : null;
  let priorMeta = {};
  try { priorMeta = existingRow?.metadata ? (typeof existingRow.metadata === 'string' ? JSON.parse(existingRow.metadata) : existingRow.metadata) : {}; } catch (e) { /* legacy */ }
  const rowData = {
    customer_id: null,
    payer_id: stmt.payer_id,
    statement_id: statementId,
    processor,
    stripe_payment_intent_id: stripePaymentIntentId,
    stripe_charge_id: stripeChargeId,
    payment_date: etDateString(settledAt instanceof Date && !Number.isNaN(settledAt.getTime()) ? settledAt : undefined),
    amount: amountCents / 100,
    base_amount_cents: baseAmountCents,
    surcharge_amount_cents: surchargeAmountCents || 0,
    surcharge_rate_bps: surchargeRateBps || 0,
    surcharge_policy_version: surchargePolicyVersion,
    card_funding: cardFunding,
    card_brand: cardBrand,
    status: 'paid',
    description: `Payer statement S-${statementId} settlement (${paymentMethod})`,
    // `payments` has no `payment_method` string column (only payment_method_id FK)
    // — the method rides metadata; payer_statements.payment_method holds it too.
    metadata: JSON.stringify({ ...priorMeta, statement_id: statementId, payer_id: stmt.payer_id, payment_method: paymentMethod, source }),
  };
  if (existingRow) await database('payments').where({ id: existingRow.id }).update(rowData);
  else await database('payments').insert(rowData);

  logger.info(`[payer-statement-settle] statement ${statementId} → paid via ${paymentMethod}; ${childrenSettled} child invoice(s) cascaded (${source})`);
  // The packet children are RETURNED, not enrolled here (local audit r29 P1):
  // both callers settle inside a transaction, and enrollment runs on the root
  // connection — it would read each child's pre-commit `unpaid` status,
  // report `invoice_unpaid`, and the settled statement would permanently miss
  // the review the technician requested. The callers enroll after commit via
  // enrollSettledPacketReviews.
  return { ok: true, statement: { ...stmt, status: 'paid', paid_at: paidAt }, childrenSettled,
    packetInvoiceIds: packetChildren.map((child) => child.id) };
}

/**
 * The deferred review of every packet-owned child of a settled statement,
 * enrolled AFTER the settlement committed (local audit r29 P1). A combined
 * visit defers its ask behind the unpaid invoice and
 * closeOutVisitForIssuedInvoice refuses packet-owned visits, so a NET
 * statement payment is the only settlement signal those asks ever get.
 * Never throws — the money has moved; an enrollment whose recovery write
 * also failed is logged for the packet recovery sweep. Returns the ids whose
 * enrollment is unrecorded.
 */
/** The open unrecorded-enrollment alerts, with the invoice ids each names. */
async function openUnrecordedEnrollmentAlerts(database = db) {
  const rows = await database('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
    .whereRaw("payload->>'reason' = 'review_enrollment_unrecorded'")
    .select('id', 'payload');
  return rows.map((alert) => {
    const payload = typeof alert.payload === 'string' ? JSON.parse(alert.payload || '{}') : (alert.payload || {});
    return { id: alert.id, invoiceIds: (Array.isArray(payload.invoiceIds) ? payload.invoiceIds : []).map(String) };
  });
}

/**
 * Retire every open alert whose invoices have ALL been recorded since. Tracked
 * per invoice, not per set (Codex #4311 r34 P2): incremental recovery makes the
 * sets overlap — [A,B] then [B] — and an exact-array match would retire the
 * wrong one and leave the other open forever.
 */
async function retireRecoveredEnrollmentAlerts(recovered, trx) {
  const recoveredSet = new Set(recovered.map(String));
  for (const alert of await openUnrecordedEnrollmentAlerts(trx)) {
    if (!alert.invoiceIds.length) continue;
    if (alert.invoiceIds.every((id) => recoveredSet.has(id))) {
      await require('./dispatch-alerts').resolveAlert({ id: alert.id, resolvedBy: null, trx });
    }
  }
}

/**
 * One open alert per INVOICE for the asks that could not be recorded. Returns
 * whether a durable signal now exists for them — the caller escalates when it
 * does not, because on a rail with no redelivery this alert is the last record
 * that the ask is still owed.
 */
async function raiseUnrecordedEnrollmentAlert(unrecorded, source, trx) {
  const alreadyNamed = new Set();
  for (const alert of await openUnrecordedEnrollmentAlerts(trx)) {
    alert.invoiceIds.forEach((id) => alreadyNamed.add(id));
  }
  const unnamed = unrecorded.filter((id) => !alreadyNamed.has(String(id)));
  if (!unnamed.length) return true; // an open alert already names them
  await require('./dispatch-alerts').createAlert({
    type: 'visit_closeout_review',
    severity: 'warn',
    trx,
    payload: {
      reason: 'review_enrollment_unrecorded',
      source,
      invoiceIds: unnamed,
      detail: 'These settled invoices owe a review ask that could not be recorded — re-run the enrollment or ask manually.',
    },
  });
  return true;
}

/** Enrollment for one settled child; never throws. */
async function enrollOneSettledPacketReview(id, database, source) {
  try {
    const invoice = await database('invoices').where({ id })
      .first('id', 'invoice_number', 'customer_id', 'service_record_id', 'visit_completion_packet_id');
    if (!invoice) return { recorded: true };
    const outcome = await require('./review-request').enrollForPaidInvoice(invoice, { source });
    return { recorded: !(outcome && outcome.recorded === false) };
  } catch (err) {
    logger.error(`[payer-statement-settle] review enrollment threw for child invoice ${id}: ${err.message}`);
    return { recorded: false };
  }
}

async function enrollSettledPacketReviews(invoiceIds, { database = db, source = 'payer_statement' } = {}) {
  const ids = (invoiceIds || []).filter(Boolean);
  if (!ids.length) return [];
  const unrecorded = [];
  for (const id of ids) {
    const { recorded } = await enrollOneSettledPacketReview(id, database, source);
    if (!recorded) unrecorded.push(id);
  }
  if (unrecorded.length) {
    logger.error(`[payer-statement-settle] ${unrecorded.length} settled packet invoice(s) have an UNRECORDED review enrollment — the packet recovery sweep owns them now`);
  }
  // The retire and the raise are ONE serialized decision (Codex #4311 r48
  // P1): dispatch_alerts has no uniqueness constraint for these payloads, so
  // two runs finishing the same paid statement — an admin reconcile and a
  // webhook replay — could both pass the dedupe read before either insert
  // committed, or a successful run could retire an alert that a failing run
  // was about to re-raise. Locking the affected invoice rows (in id order,
  // so two runs cannot deadlock) serializes the whole lifecycle.
  try {
    await db.transaction(async (trx) => {
      await trx('invoices').whereIn('id', [...ids].map(String).sort()).orderBy('id').forUpdate().select('id');
      await retireRecoveredEnrollmentAlerts(ids.filter((id) => !unrecorded.includes(id)), trx);
      if (!unrecorded.length) return;
      await raiseUnrecordedEnrollmentAlert(unrecorded, source, trx);
    });
  } catch (alertErr) {
    // The alert is the durable signal, so its own failure is escalated rather
    // than swallowed (Codex #4311 r36 P1): the caller still receives the
    // unrecorded ids and reports them to the operator.
    if (unrecorded.length) {
      logger.error(`[payer-statement-settle] could not raise the unrecorded-enrollment alert — the ONLY durable signal for ${unrecorded.length} lost review ask(s) (${unrecorded.join(', ')}): ${alertErr.message}`);
    } else {
      logger.warn(`[payer-statement-settle] could not retire an unrecorded-enrollment alert: ${alertErr.message}`);
    }
  }
  return unrecorded;
}

/**
 * Enter `processing` on a CONFIRMED money-in-flight webhook, ONLY from a payable
 * status and ONLY for the statement's active PI. Atomic conditional update —
 * returns true if it moved. A stale/replaced PI's event matches nothing.
 */
async function markStatementProcessing(statementId, piId, { database = db } = {}) {
  const moved = await database('payer_statements')
    .where({ id: statementId, stripe_payment_intent_id: piId })
    .whereIn('status', [...PAYABLE_STATEMENT_STATUSES])
    .update({ status: 'processing', updated_at: database.fn.now() });
  return moved > 0;
}

/**
 * Revert `processing → prior payable` on a payment_failed / canceled webhook for
 * the active PI (collectible again). No-op unless currently `processing` on THIS
 * PI. MUST run in the caller's transaction.
 */
async function revertStatementProcessing(statementId, piId, { database = db } = {}) {
  const stmt = await database('payer_statements')
    .where({ id: statementId, stripe_payment_intent_id: piId, status: 'processing' })
    .forUpdate()
    .first();
  if (!stmt) return false;
  await database('payer_statements').where({ id: statementId }).update({
    status: priorPayableStatus(stmt),
    updated_at: database.fn.now(),
  });
  logger.info(`[payer-statement-settle] statement ${statementId} payment ${piId} failed/canceled → ${priorPayableStatus(stmt)}`);
  return true;
}

/**
 * Stamp a statement `viewed` the first time AP opens its pay link (sent → viewed,
 * never a downgrade). `viewed` is a fact, not a dunning exit — reminders continue.
 */
async function markStatementViewed(statementId, { database = db } = {}) {
  return database('payer_statements')
    .where({ id: statementId, status: 'sent' })
    .update({ status: 'viewed', viewed_at: database.fn.now(), updated_at: database.fn.now() });
}

module.exports = {
  PAYABLE_STATEMENT_STATUSES,
  SETTLEABLE_STATEMENT_STATUSES,
  isPayableStatementStatus,
  priorPayableStatus,
  withStatementMoneyLock,
  settleStatementPaid,
  enrollSettledPacketReviews,
  markStatementProcessing,
  revertStatementProcessing,
  markStatementViewed,
};
