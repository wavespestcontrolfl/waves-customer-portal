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
 * MESSAGING is the wider rule (Codex #5424 r13). A pay link / dunning touch waits on ANY active
 * collection_hold row - a dispute OR a wrong-number / wrong-party fallback, which is an
 * all-channel outreach block (ContactPolicy FLAG_BLOCKED_CHANNELS) that must survive a dispute's
 * release. ONE predicate answers it: messagingHeldByCollectionHold (SQL twins:
 * activeMessagingHolds, collectionHoldExistsSql). The two trusted exemptions (an operator send, a
 * link the customer asked for) pass `ignoreDisputeHold`, which skips ONLY a plain dispute row,
 * never a fallback row (nor a dispute row that still carries its embedded fallback trailer) -
 * the same rule ContactPolicy applies. Charging keeps the dispute-only readers above.
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

// MESSAGING readers: ANY active collection_hold row (dispute or fallback). `ignoreDisputeHold`
// (a trusted operator / customer exemption) skips a plain dispute row only: a fallback row, and a
// dispute row that still carries its "[earlier hold: ...]" fallback trailer, keep blocking.
// In-memory twin: rowBlocksMessaging.
const EARLIER_HOLD_LIKE = `%${PRIOR_HOLD_OPEN}%${PRIOR_HOLD_CLOSE}`;
function rowBlocksMessaging(reason, { ignoreDisputeHold = false } = {}) {
  if (!ignoreDisputeHold) return true;
  return !isDisputeHoldReason(reason) || Boolean(priorHoldReasonOf(reason));
}
function activeMessagingHolds(query, { ignoreDisputeHold = false, alias = null } = {}) {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const scoped = query.where(col('flag'), HOLD_FLAG).whereNull(col('released_at'));
  if (!ignoreDisputeHold) return scoped;
  return scoped.where((w) => w
    .whereRaw(`COALESCE(${col('reason')}, '') NOT ILIKE ?`, [`${DISPUTE_REASON_PREFIX}%`])
    .orWhereRaw(`${col('reason')} LIKE ?`, [EARLIER_HOLD_LIKE]));
}

// The messaging twin of disputeHoldExistsSql: a correlated EXISTS body for the sender / dunning due
// queries (`this` is the whereExists / whereNotExists builder). Any active hold row.
function collectionHoldExistsSql(builder, outerCustomerColumn, { ignoreDisputeHold = false } = {}) {
  return activeMessagingHolds(
    builder.select(1).from('collections_flags as f').whereRaw('f.customer_id = ??', [outerCustomerColumn]),
    { ignoreDisputeHold, alias: 'f' },
  );
}

async function customerHasActiveCollectionHold(customerId, database = db) {
  if (!customerId) return false;
  const row = await activeDisputeHolds(database('collections_flags').where({ customer_id: customerId })).first('id');
  return !!row;
}

// MESSAGING: is ANY hold (dispute or fallback) active? `ignoreDisputeHold` is the trusted exemption.
async function customerHasActiveMessagingHold(customerId, database = db, { ignoreDisputeHold = false } = {}) {
  if (!customerId) return false;
  const row = await activeMessagingHolds(database('collections_flags').where({ customer_id: customerId }), { ignoreDisputeHold }).first('id');
  return !!row;
}

// Same answer, but a lookup failure throws COLLECTION_HOLD_CHECK_FAILED
// (fail closed, retryable) - the messaging twin of customerHasActiveCollectionHoldChecked.
async function customerHasActiveMessagingHoldChecked(customerId, database = db, opts = {}) {
  try {
    return await customerHasActiveMessagingHold(customerId, database, opts);
  } catch (err) {
    throw Object.assign(new Error(`Collection hold could not be verified (${err.message}). Review before sending.`), {
      code: HOLD_CHECK_FAILED_CODE,
      cause: err,
    });
  }
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

// Completion-time customer messages (the completion/report text, the decline
// notice, a deferred completion replay) leave the pay link OUT while a dispute
// hold stands: the customer was told on the call that all billing follow-up
// is on hold. The report link and the rest of the message still send. Fail
// closed - a lookup failure answers true (omit the link) rather than risk a
// pay link reaching a disputing customer.
async function shouldWithholdPayLink(customerId, database = db) {
  if (!customerId) return false;
  try {
    // ANY active hold (dispute or fallback): the completion text is automated pay-link outreach.
    return await customerHasActiveMessagingHold(customerId, database);
  } catch (err) {
    require('../logger').warn(`[collection-hold] pay-link hold lookup failed for customer ${customerId} - omitting the pay link: ${err.message}`);
    return true;
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

// ---------------------------------------------------------------------------
// Pay-link delivery under a dispute hold (owner ruling 2026-09-30).
//
// (a) While a customer has an ACTIVE dispute hold no pay link reaches them.
// (b) When the hold ends, an invoice whose pay link was held back is sent at
//     once through the normal invoice path and the Day 3-90 ladder starts.
//
// ONE chokepoint enforces (a): the scheduled-invoice SENDER
// (InvoiceService.processScheduledSends). Right after it claims a due invoice
// it asks messagingHeldByCollectionHold(); a held invoice is left `scheduled`,
// pushed a tick out with NO attempt spent, and the claim released. That covers
// an invoice queued before the hold was placed, and a lookup that failed (fail
// closed, retried every tick - never a permanent park).
//
// (b) then needs no release hook at all: every withhold point simply QUEUES
// the invoice onto that sender (queueHeldInvoiceForSender: draft -> scheduled,
// due now). While the hold stands the sender defers it; the first tick after
// the hold is released - by the admin route, the ops script, or any other
// path, since the flag row is the only thing the sender reads - sends it.
// ---------------------------------------------------------------------------

// How far the sender pushes a held invoice: just under one */5 cron tick, so
// the deferred row is due again at the very next tick (a full 5 minutes would
// land a hair AFTER that tick and cost a whole extra tick). A release is
// therefore sent within one tick.
const HOLD_DEFER_MS = 4 * 60 * 1000;
// How long a held, unresolved-Bill-To invoice (a packet or renewal-successor row) that the live fence
// confirmed self-pay stays out of the scheduled sender's due query (invoices.hold_bill_to_checked_at):
// the recheck interval at which a payer change is next picked up while the hold stands.
const HOLD_BILL_TO_RECHECK_MS = 30 * 60 * 1000;

// Lifecycle (payment.*) email templates whose body carries a pay / update-card link. ONE list
// for the fresh-send guard (payment-lifecycle-email.js) and the provider-retry rail
// (transactional-email-provider-retry.js), so a scheduled retry of a stored snapshot can never
// reach a disputing customer through a path the fresh send refuses.
// Category stamped on a payment.failed row that answers the customer's own payment attempt: the
// retry rail keeps the customerInitiated exemption from it.
const CUSTOMER_INITIATED_EMAIL_CATEGORY = 'customer_initiated';
// Category stamped on a dunning email an OPERATOR sent on purpose (the office "send now" button):
// a stored copy of it re-sent by the provider-retry rail keeps the operator exemption.
const OPERATOR_INITIATED_EMAIL_CATEGORY = 'operator_initiated';
const HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES = new Set(['payment.failed', 'payment.retry_notice', 'payment.method_expiring']);
// Machine-initiated dunning emails that carry a pay / update-card / billing link: the Day 3-90
// invoice follow-up ladder, the customer-level combined steps, the late-payment reminders
// (balance-reminder + late-payment-checker), the bank-verification re-nudge and the legacy previsit
// balance email. They are exactly the sender-rendered billing emails (billing-email-no-replay.js,
// one list, so a new dunning template cannot join one and miss the other). They go through the
// billing email authority (billing-channel-email-authority.js), which re-reads the hold at the
// provider boundary for these keys. (The routed billing.notice email leg is gated one step
// earlier, at the customer-message boundary, by HOLD_GATED_DUNNING_ENTRY_POINTS.)
const HOLD_GATED_DUNNING_EMAIL_TEMPLATES = require('../billing-email-no-replay').SENDER_RENDERED_TEMPLATES;
const HOLD_GATED_EMAIL_TEMPLATES = new Set([
  ...HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES, ...HOLD_GATED_DUNNING_EMAIL_TEMPLATES,
]);

// Customer-message entry points (sendCustomerMessage `entryPoint`) of the machine-initiated dunning
// senders. Their `purpose` is the shared 'payment_link' / 'billing', which non-dunning senders use
// too (the invoice sender, an operator's project payment link, price-change notices), so the
// boundary keys on the entry point for these. A new dunning sender must be added here (the sweep
// test fails until it is classified).
const HOLD_GATED_DUNNING_ENTRY_POINTS = new Set([
  'invoice_followup_sequence',
  'invoice_followup_customer', // the customer-level combined schedule (customer-dunning/send.js)
  'late_payment_checker',
  'late_payment_checker_microdeposit',
  'balance_reminder_workflow',
  'balance_reminder_late_payment_check',
  'previsit_balance_reminder',
]);

// The two trusted exemptions a caller can assert: a deliberate operator send, and a send the
// customer asked for themselves. Everything else waits out the hold.
function holdExemptionApplies(holdExempt) {
  return holdExempt === 'operator' || holdExempt === 'customer';
}

// A send result the hold refused BEFORE the provider. Every hold refusal anywhere in messaging is ONE
// outcome (holdDeferOutcome: COLLECTION_HOLD_DEFER, retryable + deferred + nextAllowedAt; Codex
// #5424 r14) - the customer-message boundary, the email authority, the lifecycle emails, the sender.
// It is a WAIT: the owed touch stays due and goes out after the release; the caller must not stamp a
// failure, spend an attempt or pause anything for it. (The retired COLLECTION_HOLD_SUPPRESSED code is
// still read here so a stale result shape is never mistaken for a failure; nothing emits it.)
function isHoldSuppression(result) {
  const code = result?.code || result?.reason;
  return code === 'COLLECTION_HOLD_SUPPRESSED' || code === HOLD_DEFER_CODE || result?.holdDefer === true;
}

// THE messaging-hold predicate (Codex #5424 r13): every automated pay-link / dunning leg asks it.
// { held: true, reason: 'hold' | 'lookup_failed', error? } | { held: false }.
// Held by ANY active collection_hold (dispute or wrong-number / wrong-party fallback);
// `ignoreDisputeHold` is the trusted operator / customer exemption (see the header): a plain dispute
// row is skipped, a fallback never is. Fail closed: a lookup that cannot be answered holds the send
// (retried next tick). On a caller's transaction the read runs in a SAVEPOINT, so a failed lookup
// cannot leave that (lock-holding) transaction aborted (25P02).
async function messagingHeldByCollectionHold(customerId, database = db, { ignoreDisputeHold = false } = {}) {
  if (!customerId) return { held: false };
  try {
    const held = database.isTransaction && typeof database.transaction === 'function'
      ? await database.transaction((sp) => customerHasActiveMessagingHold(customerId, sp, { ignoreDisputeHold }))
      : await customerHasActiveMessagingHold(customerId, database, { ignoreDisputeHold });
    return held ? { held: true, reason: 'hold' } : { held: false };
  } catch (err) {
    return { held: true, reason: 'lookup_failed', error: err };
  }
}

// The ONE schedulable-hold answer every delayed pay-link leg returns while a
// dispute hold stands (or cannot be verified): retryable, deferred, one cron
// tick out. Its code is in billing-channel-routing's REPLAY_HOLD_CODES and the
// scheduled-SMS rail refunds the claimed attempt for it, so a hold that lasts
// days never walks a queued leg to its attempt cap: the leg waits, then sends
// after the release.
const HOLD_DEFER_CODE = 'COLLECTION_HOLD_DEFER';
function holdDeferOutcome(held = { reason: 'hold' }) {
  return {
    code: HOLD_DEFER_CODE,
    reason: held.reason === 'lookup_failed'
      ? 'The collections dispute-hold lookup failed; delivery deferred'
      : 'Customer has an active collections dispute hold; delivery deferred until it is released',
    retryable: true,
    deferred: true,
    deliveryOutcome: 'not_sent',
    nextAllowedAt: new Date(Date.now() + HOLD_DEFER_MS).toISOString(),
  };
}

// Queue a self-pay draft invoice onto the scheduled-invoice sender - the same
// idiom the packet closeout uses (status 'scheduled', scheduled_send_at now).
// ONE guarded UPDATE moves a still-draft, unpaid, unsent, self-pay invoice with
// no other send stamp. Returns { queued: true } when THIS call moved it.
//
// A zero-row result is success ONLY when the invoice is VERIFIABLY handled: it
// is already scheduled (the sender owns it), already delivered, paid, void,
// refunded or otherwise finished, or owned by a payer / another send lane's own
// stamp. Anything else - above all a TRANSIENT 'sending' (a concurrent sender
// holds the claim and may still restore the invoice to draft) - THROWS a coded
// retryable error (QUEUE_INVOICE_NOT_SETTLED): every caller owes the invoice a
// retry, a durable alert or a deferral, never a finalized hand-off.
const QUEUE_NOT_SETTLED_CODE = 'QUEUE_INVOICE_NOT_SETTLED';
const HANDLED_INVOICE_STATUSES = new Set(['scheduled', 'sent', 'viewed', 'overdue', 'paid', 'prepaid', 'void', 'voided', 'refunded', 'canceled', 'cancelled', 'processing']);
async function queueHeldInvoiceForSender(invoiceId, database = db) {
  if (!invoiceId) return { queued: false };
  const n = await database('invoices')
    .where({ id: invoiceId, status: 'draft' })
    .whereNull('payer_id').whereNull('payer_statement_id')
    .whereNull('paid_at').whereNull('sent_at').whereNull('sms_sent_at').whereNull('email_sent_at')
    .where((q) => q.whereNull('scheduled_send_error').orWhere('scheduled_send_error', ''))
    .update({
      status: 'scheduled', scheduled_send_at: database.fn.now(), scheduled_send_attempts: 0,
      scheduled_send_error: null, updated_at: database.fn.now(),
    });
  if (Number(n) > 0) return { queued: true };
  const row = await database('invoices').where({ id: invoiceId })
    .first('status', 'payer_id', 'payer_statement_id', 'paid_at', 'sent_at', 'sms_sent_at', 'email_sent_at', 'scheduled_send_error');
  const status = String(row?.status || '').toLowerCase();
  const handled = !row
    || HANDLED_INVOICE_STATUSES.has(status)
    || row.payer_id || row.payer_statement_id
    || row.paid_at || row.sent_at || row.sms_sent_at || row.email_sent_at
    // a draft carrying another lane's own stamp (payer_billed:, renewal withheld, park) is that lane's
    || (status === 'draft' && String(row.scheduled_send_error || '') !== '');
  if (handled) return { queued: false, settled: true };
  throw Object.assign(new Error(`Invoice ${invoiceId} could not be queued behind the dispute hold (status ${status || 'unknown'}) - retry`), {
    code: QUEUE_NOT_SETTLED_CODE, retryable: true,
  });
}

// The hold answer for a STORED lifecycle email row (a provider-block retry, a bounce
// recovery): { held: false } unless the row's template carries a pay / update-card link
// (HOLD_GATED_EMAIL_TEMPLATES), it is addressed to a customer, and it is not the notice for
// the customer's OWN payment attempt (CUSTOMER_INITIATED_EMAIL_CATEGORY, stamped at send).
// Fail closed like the fresh-send guard: an unanswerable lookup is held.
async function storedLifecycleEmailHeld(message, database = db) {
  if (!HOLD_GATED_EMAIL_TEMPLATES.has(String(message?.template_key || '').trim())) return { held: false };
  if (String(message.recipient_type || '').toLowerCase() !== 'customer' || !message.recipient_id) return { held: false };
  let categories = message.categories;
  if (typeof categories === 'string') {
    try { categories = JSON.parse(categories); } catch { categories = []; }
  }
  // A stored copy of the customer's own notice / an operator's deliberate send keeps its dispute
  // exemption but still waits on a wrong-number / wrong-party fallback hold.
  const exempt = Array.isArray(categories) && (categories.includes(CUSTOMER_INITIATED_EMAIL_CATEGORY)
    || categories.includes(OPERATOR_INITIATED_EMAIL_CATEGORY));
  return messagingHeldByCollectionHold(message.recipient_id, database, { ignoreDisputeHold: exempt });
}

// A direct sender that refused on the hold and restored the invoice to draft must
// leave it SCHEDULED: a hold deferral always leaves the invoice on the sender's
// queue, so it goes out after the release. Best-effort here (the caller already
// returns the retryable refusal): a queue failure raises the durable office alert.
async function requeueHeldInvoice(invoiceId, { customerId = null } = {}) {
  try {
    await queueHeldInvoiceForSender(invoiceId);
    return true;
  } catch (err) {
    require('../logger').error(`[collection-hold] held invoice ${invoiceId} could not be re-queued after a hold refusal: ${err.message}`);
    try {
      await require('../dispatch-alerts').createAlert({
        type: 'collection_hold_invoice_queue_failed',
        severity: 'warn',
        payload: {
          invoiceId: String(invoiceId),
          customerId: customerId ? String(customerId) : null,
          error: String(err.message || err).slice(0, 300),
          action: 'A dispute hold withheld this invoice\'s pay link but the invoice could not be queued to send once the hold ends. Send it from the invoice page after the hold is released.',
        },
      });
    } catch (alertErr) {
      require('../logger').error(`[collection-hold] office alert for the un-queued held invoice ${invoiceId} also failed: ${alertErr.message}`);
    }
    return false;
  }
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
// The placeholder is never a payment at any point of its life: ARMED it is
// never-attempted, and once the retry sweep COLLECTS it the retry inserts its OWN
// paid row and the placeholder is left 'failed', disarmed, superseded by that row
// (retry_count bumped, next_retry_at cleared) - still not a failure and not history.
// A row a real attempt touched (PI stamped), one the sweep disarmed WITHOUT a
// replacement, and the orphan-charge marker (superseded by its OWN id: charged at
// Stripe, ledger row missing) stay visible like any other failed row. A
// placeholder the retry sweep resolved as absorbed by annual prepay coverage
// (self-superseded, metadata.deferred_resolution) is not a failure either.
const HOLD_DEFERRAL_REASON = 'collection_hold';
const ABSORBED_RESOLUTION = 'absorbed_annual_prepay';

function isNeverAttemptedHoldDeferral(p) {
  if (!p || p.stripe_payment_intent_id) return false;
  const armed = Number(p.retry_count || 0) === 0 && p.next_retry_at != null;
  const collected = p.superseded_by_payment_id != null && String(p.superseded_by_payment_id) !== String(p.id);
  try {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
    if (!m || m.deferred_reason !== HOLD_DEFERRAL_REASON) return false;
    return armed || collected || m.deferred_resolution === ABSORBED_RESOLUTION;
  } catch {
    return false;
  }
}

// `alias` is the payments table name/alias in the calling query. COALESCE
// keeps the NOT() NULL-safe for rows with no metadata.
function excludeNeverAttemptedHoldDeferrals(query, alias = 'payments') {
  return query.whereRaw(
    `NOT (COALESCE(${alias}.metadata->>'deferred_reason', '') = ? AND ${alias}.stripe_payment_intent_id IS NULL AND ((COALESCE(${alias}.retry_count, 0) = 0 AND ${alias}.next_retry_at IS NOT NULL) OR (${alias}.superseded_by_payment_id IS NOT NULL AND ${alias}.superseded_by_payment_id <> ${alias}.id) OR COALESCE(${alias}.metadata->>'deferred_resolution', '') = ?))`,
    [HOLD_DEFERRAL_REASON, ABSORBED_RESOLUTION],
  );
}

// Customer-facing payment history (portal) and every failed-payment consumer share the
// ONE predicate above; this is the name the history readers use.
const excludeHoldDeferralPlaceholders = excludeNeverAttemptedHoldDeferrals;

module.exports = {
  storedLifecycleEmailHeld,
  HOLD_GATED_EMAIL_TEMPLATES,
  HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES,
  HOLD_GATED_DUNNING_EMAIL_TEMPLATES,
  HOLD_GATED_DUNNING_ENTRY_POINTS,
  CUSTOMER_INITIATED_EMAIL_CATEGORY,
  OPERATOR_INITIATED_EMAIL_CATEGORY,
  holdExemptionApplies,
  isHoldSuppression,
  messagingHeldByCollectionHold,
  customerHasActiveMessagingHold,
  customerHasActiveMessagingHoldChecked,
  activeMessagingHolds,
  collectionHoldExistsSql,
  rowBlocksMessaging,
  holdDeferOutcome,
  HOLD_BILL_TO_RECHECK_MS,
  HOLD_DEFER_CODE,
  queueHeldInvoiceForSender,
  requeueHeldInvoice,
  QUEUE_NOT_SETTLED_CODE,
  HOLD_DEFER_MS,
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
  shouldWithholdPayLink,
  assertNoCollectionHold,
  collectionHoldInvoiceIds,
};
