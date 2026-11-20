// The portal's payment history: the customer-visible payments, newest first,
// with their receipt links. One read for every surface that shows a customer
// their own payments (GET /api/billing and the portal assistant's payment
// card), so the third-party-payer exclusions, hold-deferral placeholders and
// receipt rules below can never differ between them.
const db = require('../models/db');
const { excludeHoldDeferralPlaceholders } = require('./collections/collection-hold');
const StripeService = require('./stripe');
const logger = require('./logger');
const { loadPayerLinkage, excludeDirectPayerPayments, invoiceIdOf, aliasInvoiceIdOf, paymentInvoiceIds, isCombinedPayment, descriptionInvoiceNumberOf } = require('./payer-linkage');
const { invoiceAmountDue, isCollectibleOwnInvoice, invoiceWithdrawnFromCustomer, neverRanVisitStatus } = require('./invoice-helpers');
const { isNeverAttemptedDeferral } = require('./failed-payments');
const { isParkedOrSupersededAttempt } = require('./retry-collectibility');
const { whereAwaitingAuthentication } = require('./invoice-payment-authentication');

// Receipt links per payment row. Two sources, in preference order:
//   1. The Waves receipt — invoice.token drives the permanent
//      /receipt/:token page + its PDF (receipt-v2). Only for invoices the
//      PDF route will actually serve (paid/refunded), so the portal never
//      offers a download that 409s.
//   2. Stripe's hosted receipt — recurring autopay rows carry no
//      invoice_id but do stamp metadata.stripe_receipt_url (the same link
//      the payment-success SMS/email uses). View-only, no PDF.
// Customer-scoped lookup: a token is only ever returned for an invoice
// belonging to the requesting customer.
const paymentMetadataOf = (payment) => {
  try {
    const metadata = typeof payment?.metadata === 'string'
      ? JSON.parse(payment.metadata)
      : payment?.metadata;
    return metadata && typeof metadata === 'object' ? metadata : null;
  } catch {
    return null;
  }
};
const stripeReceiptOf = (p) => paymentMetadataOf(p)?.stripe_receipt_url || p.receipt_url || null;
// Invoice resolution mirrors the canonical webhook resolver
// (stripe-webhook.js): metadata.invoice_id, then the dispute/legacy
// aliases, then the payment's Stripe PaymentIntent matched against
// invoices.stripe_payment_intent_id — the last one is what rescues
// self-pay cash/check/Zelle rows, which admin-invoices.js writes with no
// metadata at all and which would otherwise show no Waves receipt.
const anyInvoiceIdOf = (p) => invoiceIdOf(p) || aliasInvoiceIdOf(p);
// Manual self-pay rows (cash/check/Zelle) are written with NEITHER
// metadata nor a PaymentIntent — admin-invoices.js only stamps metadata
// for payer-billed or credit-applied invoices. Their description is
// deterministic though: `Invoice <number> — <method>`, so the invoice
// number is the only link back and the receipt would otherwise never
// appear on a cash/check payment (codex r2 P1).
const invoiceNumberOf = descriptionInvoiceNumberOf;
const RECOVERY_INVOICE_COLUMNS = [
  'id', 'customer_id', 'scheduled_service_id', 'service_record_id', 'visit_completion_packet_id',
  'token', 'invoice_number', 'status', 'total', 'credit_applied', 'amount_paid',
  'payer_id', 'payer_statement_id', 'scheduled_send_error', 'notes', 'line_items',
  'stripe_payment_intent_id', 'stripe_charge_id',
];
const RECOVERY_PAYMENT_LIMIT = 10;
const ABSORBED_ANNUAL_PREPAY_RESOLUTION = 'absorbed_annual_prepay';

function absorbedByAnnualPrepay(payment) {
  // billing-cron writes both pieces atomically. The marker alone could be
  // stale/conflicting metadata; self-supersession alone is also how an
  // uncertain Stripe outcome is parked.
  return payment?.superseded_by_payment_id != null
    && String(payment.superseded_by_payment_id) === String(payment.id)
    && paymentMetadataOf(payment)?.deferred_resolution === ABSORBED_ANNUAL_PREPAY_RESOLUTION;
}

// The Waves receipt (token) for each visible payment's invoice, indexed by
// every linkage a payment row can carry.
async function receiptIndexFor(customerId, visiblePayments, database = db) {
  // Same UUID shape-filter the balance path already applies below: historic
  // rows can carry a non-UUID metadata.invoice_id, and invoices.id is a uuid
  // column — an unfiltered whereIn makes Postgres throw on the cast, and the
  // catch would then leave EVERY receipt link null (codex r3 P2).
  const RECEIPT_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invoiceIds = [...new Set(visiblePayments.map(anyInvoiceIdOf).filter(Boolean))]
    .filter((id) => RECEIPT_UUID_SHAPE.test(id));
  const intentIds = [...new Set(visiblePayments.map(p => p.stripe_payment_intent_id).filter(Boolean))];
  // Historical reconciled rows can be bound to their invoice ONLY through
  // payments.stripe_charge_id ↔ invoices.stripe_charge_id — the canonical
  // webhook resolver and receipt-v2's payment lookup both honor it, so the
  // billing history must too or those rows show a Stripe link (or nothing)
  // instead of the permanent Waves receipt (codex r7 P1).
  const chargeIds = [...new Set(visiblePayments.map(p => p.stripe_charge_id).filter(Boolean))];
  const invoiceNumbers = [...new Set(visiblePayments.map(invoiceNumberOf).filter(Boolean))];
  const receiptTokenByInvoiceId = new Map();
  const receiptTokenByIntentId = new Map();
  const receiptTokenByChargeId = new Map();
  const receiptTokenByNumber = new Map();
  if (invoiceIds.length || intentIds.length || chargeIds.length || invoiceNumbers.length) {
    try {
      const invoiceRows = await database('invoices')
        .where({ customer_id: customerId })
        // A payer-billed invoice still hangs off the homeowner's customer
        // row, and its receipt is a PERMANENT bearer token exposing the AP
        // payer's billing identity. The payment-history payer filter above
        // only catches rows linked by metadata.invoice_id, so the alias /
        // PaymentIntent / invoice-number paths added here would slip past
        // it — exclude payer-billed invoices outright (pre-push P0).
        .whereNull('payer_id')
        .whereIn('status', ['paid', 'refunded'])
        .where((qb) => {
          if (invoiceIds.length) qb.orWhereIn('id', invoiceIds);
          if (intentIds.length) qb.orWhereIn('stripe_payment_intent_id', intentIds);
          if (chargeIds.length) qb.orWhereIn('stripe_charge_id', chargeIds);
          if (invoiceNumbers.length) qb.orWhereIn('invoice_number', invoiceNumbers);
        })
        .select('id', 'token', 'invoice_number', 'stripe_payment_intent_id', 'stripe_charge_id');
      invoiceRows.forEach((row) => {
        if (!row.token) return;
        const entry = { token: row.token, invoiceNumber: row.invoice_number };
        receiptTokenByInvoiceId.set(row.id, entry);
        if (row.stripe_payment_intent_id) receiptTokenByIntentId.set(row.stripe_payment_intent_id, entry);
        if (row.stripe_charge_id) receiptTokenByChargeId.set(row.stripe_charge_id, entry);
        if (row.invoice_number) receiptTokenByNumber.set(row.invoice_number, entry);
      });
    } catch (err) {
      if (database !== db && (['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014'].includes(err?.code)
        || ['AbortError', 'KnexTimeoutError'].includes(err?.name))) throw err;
      // Best-effort: a receipt-link lookup failure must not break the
      // payment history itself.
      logger.warn(`[billing] receipt token lookup failed for customer ${customerId}: ${err.message}`);
    }
  }
  return { receiptTokenByInvoiceId, receiptTokenByIntentId, receiptTokenByChargeId, receiptTokenByNumber };
}

async function recoveryInvoiceAvailableNow(customerId, invoice, database) {
  try {
    // Re-read the full current row and apply checkout's shared ownership,
    // amount, deposit, and charge-reconciliation checks. customerId makes a
    // profile merge fail closed instead of returning the former owner's token.
    const verdict = await require('./pay-combined').memberCollectionPending(invoice, {
      database,
      customerId,
      // A service-record-only visit can override an account payer for the
      // standalone pay page. The shared helper deliberately ignores this
      // opt-in while combined collection is on because that checkout seam
      // cannot yet honor the same indirection. Failed bank/card rows then
      // keep Billing's safe open-invoice fallback instead of a link that 409s.
      allowStandaloneServiceRecordVisit: true,
    });
    if (!verdict?.row) return null;
    const current = verdict.row;
    // Resolve through service_record_id as well as a direct visit link. That
    // same current visit owns both the live payer verdict and the never-ran
    // settlement guard, so a late payer assignment or cancel/skip fails closed.
    const linkedVisitId = await require('./invoice').linkedScheduledServiceId(current, database);
    if (linkedVisitId) {
      const visit = await database('scheduled_services').where({ id: linkedVisitId }).first('status');
      if (neverRanVisitStatus(visit?.status)) return null;
    }
    const payerOwnership = await require('./invoice-payer-ownership').invoicePayerOwnership(
      linkedVisitId ? { ...current, scheduled_service_id: linkedVisitId } : current,
      database,
    );
    if (payerOwnership !== null) return null;
    // A packet invoice's representative visit is not enough: any billed
    // member can move the whole packet to a third-party payer.
    if (current.visit_completion_packet_id
      && await require('./visit-completion-packets').invoicePayerOwnedNow(current.id, database)) return null;
    // Checkout re-checks a termite renewal's parent before it mints money.
    // Mirror that read-only refusal here so a cancelled/refunded/moved parent
    // never gets a recovery link that the checkout immediately rejects.
    const renewalRefusal = await require('./termite-annual-renewal-charge')
      .renewalPaymentRefusal(current, database);
    if (renewalRefusal) return null;
    return current;
  } catch (err) {
    logger.warn(`[billing] failed-payment invoice ${invoice.id} is not safely collectible: ${err.message}`);
    return null;
  }
}

const RECOVERY_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecoveryPayment(payment) {
  return String(payment.status || '').toLowerCase() === 'failed'
    && !isParkedOrSupersededAttempt(payment)
    && !isNeverAttemptedDeferral(payment);
}

function recoveryLookupKeys(payments) {
  return {
    invoiceIds: [...new Set(payments.flatMap(paymentInvoiceIds)
      .filter((id) => RECOVERY_UUID_SHAPE.test(id)))],
    intentIds: [...new Set(payments.map((payment) => payment.stripe_payment_intent_id).filter(Boolean))],
    chargeIds: [...new Set(payments.map((payment) => payment.stripe_charge_id).filter(Boolean))],
    invoiceNumbers: [...new Set(payments.map(invoiceNumberOf).filter(Boolean))],
  };
}

async function loadRecoveryInvoiceRows(customerId, keys, database) {
  try {
    return await database('invoices')
      .where({ customer_id: customerId })
      .where(function linkedToFailedAttempt() {
        if (keys.invoiceIds.length) this.orWhereIn('id', keys.invoiceIds);
        if (keys.intentIds.length) this.orWhereIn('stripe_payment_intent_id', keys.intentIds);
        if (keys.chargeIds.length) this.orWhereIn('stripe_charge_id', keys.chargeIds);
        if (keys.invoiceNumbers.length) this.orWhereIn('invoice_number', keys.invoiceNumbers);
      })
      .select(...RECOVERY_INVOICE_COLUMNS);
  } catch (err) {
    if (database !== db && (['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014'].includes(err?.code)
      || ['AbortError', 'KnexTimeoutError'].includes(err?.name))) throw err;
    logger.warn(`[billing] failed-payment invoice lookup failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// Saved-bank failures clear the invoice's live PI binding after resolution.
// Retain the terminal attempt as a second, verified PI→invoice edge and load
// any invoice reachable only through that evidence before identity matching.
async function loadResolvedAttemptEvidence(customerId, intentIds, initialRows, database) {
  if (!intentIds.length) {
    return {
      rows: initialRows,
      resolvedFailedAttempts: [],
      attemptLookupFailed: false,
    };
  }
  try {
    const resolvedFailedAttempts = await database('stripe_invoice_charge_attempts as attempt')
      .join('invoices as attempt_invoice', 'attempt_invoice.id', 'attempt.invoice_id')
      .where({ 'attempt_invoice.customer_id': customerId, 'attempt.status': 'failed' })
      .whereIn('attempt.stripe_payment_intent_id', intentIds)
      .whereNotNull('attempt.resolved_at')
      .select('attempt.invoice_id', 'attempt.stripe_payment_intent_id');
    const loadedIds = new Set(initialRows.map((row) => String(row.id)));
    const missingIds = [...new Set(resolvedFailedAttempts.map((attempt) => String(attempt.invoice_id)))]
      .filter((id) => !loadedIds.has(id));
    if (!missingIds.length) {
      return {
        rows: initialRows,
        resolvedFailedAttempts,
        attemptLookupFailed: false,
      };
    }
    const supplementalRows = await database('invoices')
      .where({ customer_id: customerId })
      .whereIn('id', missingIds)
      .select(...RECOVERY_INVOICE_COLUMNS);
    return {
      rows: [...initialRows, ...supplementalRows],
      resolvedFailedAttempts,
      attemptLookupFailed: false,
    };
  } catch (err) {
    logger.warn(`[billing] failed-payment charge-attempt lookup failed for customer ${customerId}: ${err.message}`);
    return {
      rows: initialRows,
      resolvedFailedAttempts: [],
      attemptLookupFailed: true,
    };
  }
}

// authentication_required is not a terminal processor decline: the
// off-session PI can remain in requires_action and succeed later. Its failed
// payment row deliberately omits the PI id, so resolve payment identity first,
// then ask by EVERY candidate invoice id (metadata, number, charge, or PI).
// A failed read is unknown, not terminal; callers withhold the whole batch.
async function loadAuthenticationRecoveryStates(customerId, invoices, database) {
  const invoiceIds = [...new Set(invoices.map((invoice) => String(invoice.id)))];
  if (!invoiceIds.length) return new Map();
  try {
    // Read the pre-resolution claim and the resolved authentication decline
    // in one statement. The saved-card writer can move claimed -> failed
    // between separate reads; either side may still own a completable intent.
    const rows = await database('stripe_invoice_charge_attempts as attempt')
      .join('invoices as attempt_invoice', 'attempt_invoice.id', 'attempt.invoice_id')
      .where({ 'attempt_invoice.customer_id': customerId })
      .where(function authenticationMayStillSettle() {
        this.where(function unresolvedAttempt() {
          this.whereIn('attempt.status', ['claimed', 'ambiguous'])
            .whereNull('attempt.resolved_at');
        }).orWhere((q) => whereAwaitingAuthentication(q, 'attempt'));
      })
      .whereIn('attempt.invoice_id', invoiceIds)
      .select('attempt.invoice_id', 'attempt.status', 'attempt.decline_code', 'attempt.resolved_at');
    const states = new Map();
    for (const row of rows) {
      const id = String(row.invoice_id);
      if (row.status === 'failed' && row.decline_code === 'authentication_required' && row.resolved_at) {
        states.set(id, 'authentication_pending');
      } else if (!row.resolved_at && ['claimed', 'ambiguous'].includes(row.status) && !states.has(id)) {
        states.set(id, 'authentication_unknown');
      }
    }
    return states;
  } catch (err) {
    logger.warn(`[billing] failed-payment authentication lookup failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

function rowSetIndex(rows, keyOf, normalize = String) {
  const index = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const normalized = normalize(key);
    const matches = index.get(normalized) || [];
    matches.push(row);
    index.set(normalized, matches);
  }
  return index;
}

function recoveryIdentityIndexes(rows, resolvedFailedAttempts) {
  const byId = rowSetIndex(rows, (row) => row.id, (value) => String(value).toLowerCase());
  const byResolvedAttemptIntent = new Map();
  for (const attempt of resolvedFailedAttempts) {
    const invoiceMatches = byId.get(String(attempt.invoice_id || '').toLowerCase()) || [];
    if (invoiceMatches.length !== 1 || !attempt.stripe_payment_intent_id) continue;
    const key = String(attempt.stripe_payment_intent_id);
    const matches = byResolvedAttemptIntent.get(key) || new Map();
    matches.set(String(invoiceMatches[0].id), invoiceMatches[0]);
    byResolvedAttemptIntent.set(key, matches);
  }
  return {
    byId,
    byIntent: rowSetIndex(rows, (row) => row.stripe_payment_intent_id),
    byCharge: rowSetIndex(rows, (row) => row.stripe_charge_id),
    byNumber: rowSetIndex(rows, (row) => row.invoice_number),
    byResolvedAttemptIntent,
  };
}

function stripeMatchGroups(payment, indexes) {
  const groups = [];
  if (payment.stripe_payment_intent_id) {
    const intentId = String(payment.stripe_payment_intent_id);
    // A resolved attempt may restore a cleared binding, but cannot hide a
    // conflicting live binding or a second attempt claiming the same PI.
    const matches = new Map();
    for (const row of (indexes.byIntent.get(intentId) || [])) matches.set(String(row.id), row);
    for (const row of (indexes.byResolvedAttemptIntent.get(intentId)?.values() || [])) {
      matches.set(String(row.id), row);
    }
    groups.push([...matches.values()]);
  }
  if (payment.stripe_charge_id) {
    groups.push(indexes.byCharge.get(String(payment.stripe_charge_id)) || []);
  }
  return groups;
}

function groupsIdentifyCandidate(groups, candidate) {
  return groups.every((group) => group.length === 1 && group[0] === candidate);
}

function stripeGroupsIdentifyCandidate(groups, candidate, combined) {
  return groups.every((group) => (combined
    ? group.includes(candidate)
    : group.length === 1 && group[0] === candidate));
}

function paymentMayPublishInvoice(payment, invoice) {
  if (String(invoice?.status || '').toLowerCase() !== 'draft') return true;
  return String(invoiceIdOf(payment) || '').toLowerCase() === String(invoice?.id || '').toLowerCase();
}

function recoveryInvoiceForPayment(payment, indexes) {
  const explicitGroups = paymentInvoiceIds(payment).map((id) => indexes.byId.get(id) || []);
  const invoiceNumber = invoiceNumberOf(payment);
  const strictGroups = invoiceNumber
    ? [...explicitGroups, indexes.byNumber.get(invoiceNumber) || []]
    : explicitGroups;
  const stripeGroups = stripeMatchGroups(payment, indexes);
  const candidateGroup = strictGroups.length ? strictGroups[0] : stripeGroups[0];
  const candidate = candidateGroup?.length === 1 ? candidateGroup[0] : null;
  const combined = isCombinedPayment(payment);
  if (!candidate || (combined && !explicitGroups.length)) return null;
  if (!groupsIdentifyCandidate(strictGroups, candidate)) return null;
  if (!stripeGroupsIdentifyCandidate(stripeGroups, candidate, combined)) return null;
  return paymentMayPublishInvoice(payment, candidate) ? candidate : null;
}

function identifyRecoveryInvoices(payments, indexes, attemptLookupFailed) {
  const invoiceByPaymentId = new Map();
  // A failed evidence lookup means a historic binding or live SCA intent
  // could conflict with the current invoice stamp. Keep the history rows,
  // but withhold every bearer recovery link from this bounded batch.
  if (attemptLookupFailed) return invoiceByPaymentId;
  for (const payment of payments) {
    const invoice = recoveryInvoiceForPayment(payment, indexes);
    if (invoice) invoiceByPaymentId.set(String(payment.id), invoice);
  }
  return invoiceByPaymentId;
}

function recoveryInvoiceIsPayable(invoice, ownedIds = null) {
  if (!invoice?.token || !(invoiceAmountDue(invoice) > 0)) return false;
  if (ownedIds?.has(String(invoice.id))) return false;
  if (String(invoice.status || '').toLowerCase() !== 'draft') return isCollectibleOwnInvoice(invoice);
  return !invoice.payer_id && !invoice.payer_statement_id && !invoiceWithdrawnFromCustomer(invoice);
}

// A failed history row may offer a Pay action only for the invoice that the
// attempt itself identifies. The account's oldest open invoice is unrelated
// when a customer has more than one balance, and using it here can put a $60
// pay link under a failed $95 attempt. Resolve every canonical linkage the
// payment ledger supports, then fail closed when the row's identifiers are
// absent, conflicting, payer-owned, settled, withdrawn, or fully covered.
function emptyRecoveryDetails() {
  return {
    recoveryByPaymentId: new Map(),
    recoveryStateByPaymentId: new Map(),
  };
}

function recoveryFieldsFor(payment, { recoveryByPaymentId, recoveryStateByPaymentId }) {
  const id = String(payment.id);
  if (payment.status === 'failed') {
    if (isNeverAttemptedDeferral(payment)
      || absorbedByAnnualPrepay(payment)
      || (payment.superseded_by_payment_id != null && String(payment.superseded_by_payment_id) !== id)) {
      return { recoveryInvoice: null, recoveryState: 'recovery_inactive' };
    }
    if (isParkedOrSupersededAttempt(payment)) {
      return { recoveryInvoice: null, recoveryState: 'authentication_unknown' };
    }
  }
  return {
    recoveryInvoice: recoveryByPaymentId.get(id) || null,
    // Do not collapse this into an ordinary unavailable invoice. The client
    // must replace its new pay/list shortcuts with verification guidance
    // while the original off-session intent can still settle.
    recoveryState: recoveryStateByPaymentId.get(id) || null,
  };
}

function unknownRecoveryDetails(payments) {
  return {
    recoveryByPaymentId: new Map(),
    recoveryStateByPaymentId: new Map(payments.map((payment) => [
      String(payment.id), 'authentication_unknown',
    ])),
  };
}

function markUncheckedRecoveryStates(details, payments, checkedLimit) {
  // Direct-link verification is deliberately capped, but an unchecked row
  // must not regain the generic invoice-list fallback merely by falling just
  // outside that cap (or onto a later history page).
  const unchecked = payments.filter(isRecoveryPayment).slice(checkedLimit);
  for (const payment of unchecked) {
    const id = String(payment.id);
    if (!details.recoveryByPaymentId.has(id) && !details.recoveryStateByPaymentId.has(id)) {
      details.recoveryStateByPaymentId.set(id, 'recovery_unchecked');
    }
  }
  return details;
}

async function recoveryDetailsFor(customerId, visiblePayments, database = db) {
  const failedPayments = visiblePayments.filter(isRecoveryPayment)
    // Checkout parity requires several read-only fences per candidate. Keep
    // that work bounded to the newest failures; every other row remains
    // ineligible for a direct bearer recovery link.
    .slice(0, RECOVERY_PAYMENT_LIMIT);
  const keys = recoveryLookupKeys(failedPayments);
  if (!Object.values(keys).some((values) => values.length > 0)) return emptyRecoveryDetails();
  const initialRows = await loadRecoveryInvoiceRows(customerId, keys, database);
  if (!initialRows) return unknownRecoveryDetails(failedPayments);

  // An asynchronous saved-bank failure reopens the invoice and deliberately
  // clears its PaymentIntent. The resolved charge-attempt row retains the
  // verified invoice/PI pair, so load that terminal evidence before identity
  // matching. Resolve by PI across every invoice owned by this customer before
  // narrowing candidates; otherwise a different invoice's live PI stamp can
  // hide the cleared invoice named by the resolved attempt.
  const {
    rows, resolvedFailedAttempts, attemptLookupFailed,
  } = await loadResolvedAttemptEvidence(
    customerId, keys.intentIds, initialRows, database,
  );

  // Establish identity against every matching invoice before deciding whether
  // it is payable. Otherwise a settled invoice named by metadata could be
  // filtered out first and an unrelated payable invoice sharing another key
  // could win. All identifiers on an ordinary attempt must resolve uniquely
  // to one invoice; marked combined shares are handled explicitly below.
  const indexes = recoveryIdentityIndexes(rows, resolvedFailedAttempts);
  if (attemptLookupFailed) return unknownRecoveryDetails(failedPayments);
  const invoiceByPaymentId = identifyRecoveryInvoices(failedPayments, indexes, attemptLookupFailed);

  const authenticationStates = await loadAuthenticationRecoveryStates(
    customerId, [...invoiceByPaymentId.values()], database,
  );
  if (!authenticationStates) {
    const outstandingPayments = failedPayments.filter((payment) => (
      recoveryInvoiceIsPayable(invoiceByPaymentId.get(String(payment.id)))
    ));
    return unknownRecoveryDetails(outstandingPayments);
  }
  const recoveryStateByPaymentId = new Map();
  for (const [paymentId, invoice] of invoiceByPaymentId) {
    const authenticationState = authenticationStates.get(String(invoice.id));
    if (!authenticationState || !recoveryInvoiceIsPayable(invoice)) continue;
    recoveryStateByPaymentId.set(paymentId, authenticationState);
    invoiceByPaymentId.delete(paymentId);
  }

  const identifiedInvoices = [...new Map([...invoiceByPaymentId.values()]
    .map((row) => [String(row.id), row])).values()];
  if (!identifiedInvoices.length) {
    return { recoveryByPaymentId: new Map(), recoveryStateByPaymentId };
  }
  const ownership = await require('./invoice-payer-ownership').liveInvoiceOwnership(
    customerId, identifiedInvoices, database, { maxResolutions: 30, byCandidatePayer: true },
  );
  const availableInvoices = new Map();
  for (const invoice of identifiedInvoices) {
    if (ownership.unverifiable || !recoveryInvoiceIsPayable(invoice, ownership.ownedIds)) continue;
    const current = await recoveryInvoiceAvailableNow(customerId, invoice, database);
    if (recoveryInvoiceIsPayable(current)) availableInvoices.set(String(invoice.id), current);
  }

  const failedPaymentById = new Map(failedPayments.map((payment) => [String(payment.id), payment]));
  const recoveryByPaymentId = new Map();
  for (const [paymentId, invoice] of invoiceByPaymentId) {
    const current = availableInvoices.get(String(invoice.id));
    if (!current) {
      if (recoveryInvoiceIsPayable(invoice)) {
        recoveryStateByPaymentId.set(paymentId, 'recovery_unavailable');
      }
      continue;
    }
    const payment = failedPaymentById.get(paymentId);
    // If the fresh row moved back to draft after identity resolution, retain
    // Billing's stricter rule: only its canonical explicit invoice id may
    // publish that otherwise-undelivered debt.
    if (!payment || !paymentMayPublishInvoice(payment, current)) continue;
    recoveryByPaymentId.set(paymentId, {
      payUrl: `/pay/${current.token}`,
      amountDue: invoiceAmountDue(current),
      invoiceNumber: current.invoice_number || null,
    });
  }
  return { recoveryByPaymentId, recoveryStateByPaymentId };
}

async function recoveryInvoiceIndexFor(customerId, visiblePayments, database = db) {
  const { recoveryByPaymentId } = await recoveryDetailsFor(customerId, visiblePayments, database);
  return recoveryByPaymentId;
}

async function portalRecoveryDetailsFor({
  includeRecoveryInvoices,
  payerLookupFailed,
  requestedCursor,
  customerId,
  visiblePayments,
  database,
}) {
  if (!includeRecoveryInvoices) return emptyRecoveryDetails();
  const enrichmentEnabled = !payerLookupFailed && Number(requestedCursor) === 0;
  const details = enrichmentEnabled
    ? await recoveryDetailsFor(customerId, visiblePayments, database)
    : emptyRecoveryDetails();
  return markUncheckedRecoveryStates(
    details,
    visiblePayments,
    enrichmentEnabled ? RECOVERY_PAYMENT_LIMIT : 0,
  );
}

async function listPortalPayments(customerId, {
  limit: requestedLimit = 50,
  cursor: requestedCursor = 0,
  database = db,
  includeRecoveryInvoices = false,
} = {}) {
  const service = await StripeService;

  // Third-party Bill-To: a payment against a payer-billed invoice belongs to
  // the payer (AP contact), not the homeowner — drop those rows so the
  // logged-in customer never sees the payer's card brand / last4 / Stripe
  // PaymentIntent id in their own history. Over-fetch first so excluding those
  // rows still returns up to `requestedLimit` customer-visible payments (the
  // exclusion can't be a SQL filter without casting arbitrary payment metadata
  // to jsonb table-wide). Payer payments are a small minority, so a padded
  // buffer fills the page in realistic cases.
  // ONE shared payer predicate (services/payer-linkage.js, also used by the SMS payment facts): every linkage the receipt
  // resolution below understands, the payer_billed withdrawal stamp, statement-accrued children, and the direct ledger stamps
  // (payments.payer_id / metadata.payer_id).
  const { failed: payerLookupFailed, payerInvoiceIds, isPayerLinked } = await loadPayerLinkage(customerId, database, { propagateCancellation: database !== db });
  // `total` counts exactly the rows pagination will serve: the same
  // hold-deferral exclusion and the same payer predicate. The direct payer
  // stamps (payments.payer_id, metadata.payer_id) are SQL, so the common
  // case (no payer invoice on file) stays one COUNT(*) per page; only an
  // account with payer invoices scans its rows for the invoice-linked ones.
  let total;
  if (payerInvoiceIds.size === 0) {
    const countRow = await excludeDirectPayerPayments(excludeHoldDeferralPlaceholders(database('payments')
      .where({ customer_id: customerId }), 'payments'))
      .count('* as count')
      .first();
    total = Number(countRow?.count || 0);
  } else {
    const rows = await excludeDirectPayerPayments(excludeHoldDeferralPlaceholders(database('payments')
      .where({ customer_id: customerId }), 'payments'))
      .select('metadata', 'stripe_payment_intent_id', 'stripe_charge_id', 'description', 'payer_id');
    total = rows.reduce((count, payment) => count + (isPayerLinked(payment) ? 0 : 1), 0);
  }

  // `cursor` is the raw payment-history offset. Scan bounded chunks so a
  // page still contains up to `limit` customer-visible rows when third-party
  // payer rows are interspersed. The cursor points at (not beyond) the first
  // visible look-ahead row, so no payment is lost between pages.
  const visiblePayments = [];
  const batchSize = 100;
  let rawCursor = requestedCursor;
  let nextCursor = null;
  let exhausted = false;
  for (let scan = 0; scan < 10 && !exhausted && nextCursor == null; scan += 1) {
    const batch = await service.getPaymentHistory(customerId, batchSize, rawCursor, database);
    if (!batch.length) {
      exhausted = true;
      break;
    }
    for (let index = 0; index < batch.length; index += 1) {
      const payment = batch[index];
      if (isPayerLinked(payment)) continue;
      if (visiblePayments.length < requestedLimit) visiblePayments.push(payment);
      else {
        nextCursor = rawCursor + index;
        break;
      }
    }
    if (nextCursor != null) break;
    rawCursor += batch.length;
    if (batch.length < batchSize) exhausted = true;
  }
  if (nextCursor == null && !exhausted) {
    // The bounded scan may encounter an unusually long run of payer-only
    // rows. Continue from the raw position on the next request rather than
    // scanning without limit or claiming the history is complete.
    nextCursor = rawCursor;
  }

  // Recurring = the monthly WaveGuard plan obligation. Metadata-first, same
  // rule as billing-cron's dedupe: every monthly-autopay row (chargeMonthly,
  // retry rungs, admin charge-now) carries a metadata.billed_month stamp.
  // The canonical "<tier> WaveGuard Monthly" description marker stays as the
  // legacy fallback for rows written before the stamp existed. Description
  // wording alone (e.g. a row that merely says "Monthly") is NOT a signal.
  const isRecurringPayment = (p) => {
    if (paymentMetadataOf(p)?.billed_month) return true;
    return (p.description || '').includes('WaveGuard Monthly');
  };

  const { receiptTokenByInvoiceId, receiptTokenByIntentId, receiptTokenByChargeId, receiptTokenByNumber } = await receiptIndexFor(customerId, visiblePayments, database);
  // Ownership could not be established means the invoice might belong to an
  // AP payer. Withhold every recovery link until that read succeeds.
  // BillingTab follows every history cursor before rendering. Enrich only its
  // first page so a long ledger cannot multiply the per-invoice fence reads
  // across as many as 50 sequential requests.
  const recoveryDetails = await portalRecoveryDetailsFor({
    includeRecoveryInvoices,
    payerLookupFailed,
    requestedCursor,
    customerId,
    visiblePayments,
    database,
  });

  return {
    payments: visiblePayments.map(p => ({
      id: p.id,
      date: p.payment_date,
      amount: parseFloat(p.amount),
      status: p.status,
      description: p.description,
      // The client's Recurring/One-Time filter and YTD split read this —
      // it was previously never serialized (always $0.00).
      type: isRecurringPayment(p) ? 'recurring' : 'one_time',
      cardBrand: p.card_brand,
      lastFour: p.last_four,
      processor: 'stripe',
      methodType: p.method_type || 'card',
      bankName: p.bank_name || null,
      stripePaymentIntentId: p.stripe_payment_intent_id || null,
      refundAmount: p.refund_amount ? parseFloat(p.refund_amount) : null,
      refundStatus: p.refund_status || null,
      ...(includeRecoveryInvoices
        ? recoveryFieldsFor(p, recoveryDetails)
        : {}),
      // Receipt surfaces (see the resolution block above). All three are
      // null when this payment has no retrievable receipt — the row simply
      // renders no receipt action.
      ...(() => {
        // A FAILED attempt can carry the same metadata.invoice_id as the
        // retry that later succeeded (stripe.js persists failed saved-card
        // attempts with it). Attaching the invoice receipt to that row would
        // show a receipt beside a FAILED badge for money this row never
        // took — only settled rows get one (codex r2 P1).
        // Fail closed: if payer ownership couldn't be resolved we cannot
        // prove this row is self-pay, so no receipt link is emitted.
        const settled = !payerLookupFailed
          && ['paid', 'processing', 'refunded'].includes(String(p.status || '').toLowerCase());
        const inv = !settled ? null : (
          receiptTokenByInvoiceId.get(anyInvoiceIdOf(p))
          || (p.stripe_payment_intent_id ? receiptTokenByIntentId.get(p.stripe_payment_intent_id) : null)
          || (p.stripe_charge_id ? receiptTokenByChargeId.get(p.stripe_charge_id) : null)
          || receiptTokenByNumber.get(invoiceNumberOf(p))
        );
        const stripeReceiptUrl = stripeReceiptOf(p);
        return {
          receiptUrl: inv ? `/receipt/${inv.token}` : null,
          receiptPdfUrl: inv ? `/api/receipt/${inv.token}/pdf` : null,
          receiptNumber: inv?.invoiceNumber || null,
          stripeReceiptUrl: (inv || !settled) ? null : stripeReceiptUrl,
        };
      })(),
    })),
    total,
    limit: requestedLimit,
    cursor: requestedCursor,
    hasMore: nextCursor != null,
    nextCursor,
    // True when third-party-payer ownership could not be read: the rows
    // above may then include a payer's payments. The Billing tab keeps its
    // prior behavior (receipt links withheld); a consumer that would show
    // the figures elsewhere must show nothing.
    payerLookupFailed,
  };
}

module.exports = { listPortalPayments, recoveryInvoiceIndexFor };
