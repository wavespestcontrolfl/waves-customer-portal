const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { noStore } = require('../middleware/no-store');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');

// Every response here is keyed by a bearer token in the URL and carries
// financial/personal data — never cacheable, never indexable.
router.use(noStore);
const InvoiceService = require('../services/invoice');
const { customerSafeVisitNotes } = require('../services/context-aggregator');
const InvoiceAttachments = require('../services/invoice-attachments');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
const { generateInvoicePDF } = require('../services/pdf/invoice-pdf');
const ConsentService = require('../services/payment-method-consents');
const {
  CONSENT_VERSION_METADATA_KEY, consentVersionStaleResponse, renderedConsentVersionIsCurrent,
} = require('../services/payment-method-consent-text');
const logger = require('../services/logger');
const { assertInvoiceCollectible, assertInvoiceNotWithdrawnFromCustomer, invoiceWithdrawnFromCustomer, isInvoiceCollectibleStatus, invoiceAmountDue } = require('../services/invoice-helpers');
const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');
const BillPaymentErrorAlerts = require('../services/bill-payment-error-alerts');
const { shouldSkipClientPaymentErrorAlert, manualPayOptionsFromEnv } = require('./pay-v2-helpers');
// Lives in services/pay-combined.js (shared with the customer-dunning set); import it from there.
const { invoiceCreditWouldFullyCover } = require('../services/pay-combined');

/**
 * Public pay routes — no auth required.
 * Customers access these via invoice token links (e.g. /pay/abc123def456).
 */

// Unauthenticated by-token money surface: rate-limit the whole router
// (defense in depth over the global /api/ limiter) and reject malformed
// tokens before any DB lookup. Mirrors the pay-statement.js pattern.
const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Too many requests — please slow down.' },
});
router.use(payLimiter);

// Current invoice tokens are randomBytes(32).hex (64 chars); legacy rows
// carry 25-32 char url-safe tokens (prod-verified 2026-08-07: all 339 live
// tokens match this range/charset). Format gate → generic 404, same body as
// an unknown token so the two are indistinguishable.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
router.param('token', (req, res, next, token) => {
  if (!TOKEN_RE.test(String(token))) return res.status(404).json({ error: 'Invoice not found' });
  next();
});

const clientPaymentErrorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment error reports. Please call (941) 297-5749.' },
});

function cleanField(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function paymentRouteLabel(req) {
  if (req.route?.path) {
    return `${req.method} ${req.baseUrl || ''}${req.route.path}`;
  }
  const rawPath = req.originalUrl || req.path || '';
  const token = req.params?.token;
  const safePath = token ? rawPath.replace(String(token), ':token') : rawPath;
  return `${req.method} ${safePath}`;
}

function reportBillPaymentError(req, {
  invoice,
  phase,
  methodCategory,
  paymentIntentId,
  error,
  message,
  code,
  statusCode,
  source = 'server',
  metadata = {},
}) {
  if (!invoice?.id) return;
  BillPaymentErrorAlerts.alertBillPaymentError({
    invoice,
    phase,
    methodCategory,
    paymentIntentId,
    error,
    message,
    code,
    statusCode,
    source,
    metadata: {
      route: paymentRouteLabel(req),
      method: req.method,
      ...metadata,
    },
  }).catch((alertErr) => {
    logger.warn(`[pay-v2] Bill payment error alert failed for invoice ${invoice.id}: ${alertErr.message}`);
  });
}

function respondWithPaymentError(req, res, {
  invoice,
  phase,
  methodCategory,
  paymentIntentId,
  error,
  message,
  code,
  statusCode = 400,
  clientMessage,
  metadata,
}) {
  reportBillPaymentError(req, {
    invoice,
    phase,
    methodCategory,
    paymentIntentId,
    error,
    message,
    code,
    statusCode,
    metadata,
  });
  return res.status(statusCode).json({ error: clientMessage || message || error?.message || 'Payment error' });
}

async function rejectIfInvoiceCollectionPending(invoice, res, { recordExistingPayment = false } = {}) {
  try {
    if (!recordExistingPayment) {
      await require('../services/estimate-deposits').assertInvoiceDepositSettlementReady(db, invoice, { lock: false });
    }
    await StripeService.assertNoInvoiceChargeReconciliationPending(invoice.id);
    return false;
  } catch (err) {
    if (err.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
      res.status(409).json({ error: err.message, reconciliationRequired: true });
      return true;
    }
    if (!StripeService.savedCardChargeSuppressesAlternateCollection(err)) throw err;
    const reconciliationRequired = StripeService.savedCardChargeNeedsReconciliation(err);
    if (reconciliationRequired) {
      // A stale claim is promoted to ambiguity by the fence lookup. Persist
      // that state on the invoice too, so status-only collection paths that do
      // not know about the attempt table cannot open another payment rail.
      await StripeService.parkInvoiceForSavedCardReconciliation({
        invoiceId: invoice.id,
        error: err,
      });
    }
    res.status(409).json({
      error: 'A saved payment method attempt is in progress or awaiting verification. Please do not pay again yet.',
      inProgress: false,
      savedCardPending: true,
      reconciliationRequired,
    });
    return true;
  }
}

// =========================================================================
// GET /api/pay/:token — Invoice data + processor info + Stripe key
// =========================================================================
// A recurring estimate accept REQUIRES a payment method on file (owner
// ruling 2026-07-09). Server-authoritative — never a client-editable URL
// param (Codex #2507 P1). Two legs:
//  1. billing_mode per_application/annual_prepay — stamped BEFORE the
//     acceptance invoice is paid, covers estimate-flow signups.
//  2. A CURRENT monthly member accepting a recurring add-on keeps their
//     billing_mode (converter preservesExistingMembership, round-7), but
//     their accept links are still sent saveRequired=1 like every
//     recurring accept — enforce the same requirement here or the GET
//     unlocks the box and setup/finalize honor saveCard=false (Codex
//     #2507 round-2). Detected mode-independently: the invoice's
//     scheduled service traces to an accepted estimate
//     (source_estimate_id), the customer has a recurring relationship
//     (monthly_rate > 0), AND the visit itself is a RECURRING one — the
//     same marker trio project-completion treats as canonical
//     (is_recurring / recurring_parent_id / recurring_pattern), so a
//     monthly member's ONE-TIME estimate accept stays exempt (Codex
//     #2507 round-3: one-time links are sent saveCard: !treatAsOneTime,
//     not save-required). Schedule-created visits (no source estimate)
//     stay exempt too.
// Payer-billed invoices never save on the homeowner account.
// Column-guarded: pre-migration environments require nothing.
async function invoiceRequiresSavedMethod(invoice, { database = db } = {}) {
  const customerId = invoice?.customer_id || invoice?.customer?.id;
  if (!customerId || invoice?.payer_id) return false;
  try {
    const row = await database('customers').where({ id: customerId }).first('billing_mode', 'monthly_rate');
    if (['per_application', 'annual_prepay'].includes(row?.billing_mode)) return true;
    if (!(Number(row?.monthly_rate) > 0)) return false;
    const scheduledServiceId = invoice?.scheduled_service_id || invoice?.scheduledServiceId;
    if (!scheduledServiceId) return false;
    const ss = await database('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('source_estimate_id', 'is_recurring', 'recurring_parent_id', 'recurring_pattern');
    if (!ss?.source_estimate_id) return false;
    return !!(ss.is_recurring || ss.recurring_parent_id || ss.recurring_pattern);
  } catch (err) {
    // Only the EXPECTED pre-migration shape (billing_mode column/table not
    // there yet) may relax the requirement. Anything else — a transient
    // read failure in migrated prod — must surface: every server-side
    // enforcement of required-save calls this helper, so swallowing the
    // error would let /setup, /update-amount and /finalize stop forcing
    // saveCard and the recurring signup completes with no saved method
    // (Codex #2507 round-6 P1). Failing the request is the fail-closed
    // path — the customer retries a transient error, the requirement never
    // silently disappears.
    if (err?.code === '42703' || err?.code === '42P01') return false;
    throw err;
  }
}

// Nothing chargeable is on file for this required-save customer. Used by
// /setup, GET (invoice.captureNeeded) and /capture-setup so the
// covered-by-credit capture state is derivable on EVERY load, not only
// from the one /setup response (Codex #2507 P1 round-3).
//
// Tests for a saved chargeable METHOD (canonical default row + ACH
// health), NOT the full customerOnAutopay predicate (Codex #2507 round-6
// P2 → round-7): capture exists to guarantee a method is ON FILE for
// future collection. A pause (autopay_paused_until) or a flipped-off
// customer flag are account states the capture flow neither can nor
// should override — enrollConsentedMethod doesn't clear a pause, so
// treating "paused" as "capture needed" asks a customer who already has a
// valid method for another one, forever.
async function invoiceCaptureNeeded(invoice) {
  try {
    const { getChargeableAutopayMethod, isChargeableAutopayMethod } = require('../services/autopay-eligibility');
    const customerRow = await db('customers').where({ id: invoice.customer_id }).first();
    if (!customerRow) return false;
    const method = await getChargeableAutopayMethod(customerRow, db);
    if (!isChargeableAutopayMethod(method)) return true;
    // A bank default while the customer's ACH state is unhealthy is not
    // chargeable — same predicate as customerOnAutopay's ACH leg.
    if (customerRow.ach_status && customerRow.ach_status !== 'active' && method.method_type !== 'card') return true;
    return false;
  } catch (err) {
    // This is the ONLY gate deciding whether a credit-covered required-save
    // signup must complete the capture step, and no PaymentIntent/webhook
    // path exists to save a method for it — so an unknown autopay state
    // must read as "capture needed", never "all set" (Codex #2507 round-6
    // P1). A spurious true only shows the capture step; /capture-setup
    // re-derives the need server-side before minting, so it can never
    // double-save or charge.
    logger.warn(`[pay-v2] captureNeeded lookup failed for invoice ${invoice?.id}: ${err.message} — failing closed (capture needed)`);
    return true;
  }
}

// Account credit /setup WILL auto-apply to this invoice (same gate + opt-in
// as invoiceCreditWouldFullyCover), so the pay page can show the post-credit
// amount before /setup answers. 0 when the gate is off / opted out / no credit.
async function invoiceProjectedCreditApplied(invoice, { database = db } = {}) {
  if (!require('../config/feature-gates').gates.autoApplyAccountCredit) return 0;
  if (!invoice?.customer_id || invoice?.payer_id) return 0;
  const row = await database('customers').where({ id: invoice.customer_id }).first('account_credits', 'auto_apply_account_credit');
  if (row?.auto_apply_account_credit !== true) return 0;
  const credit = Number(row?.account_credits) || 0;
  if (!(credit > 0)) return 0;
  return Math.min(Math.round(credit * 100), Math.round(invoiceAmountDue(invoice) * 100)) / 100;
}

// The SINGLE eligibility predicate for offering an off-Stripe transfer
// (Zelle today) on this invoice — extracted (independent-review P1, PR
// #5331) so the SMS real-answers PAYMENT OPTIONS fact can ask the exact
// same question the public pay page answers here, instead of maintaining
// a second copy that can silently disagree. Byte-identical to the inline
// predicate this replaced: off-Stripe tenders are offered only when a
// transfer is actually the right thing to do (codex #3610 P1 ×2) — never
// when the invoice must capture a saved method (a Zelle transfer creates
// neither the Stripe method nor the consent a recurring signup needs;
// owner ruling 2026-09-28: new customers pay at visit, card on file only),
// never when account credit will settle the whole invoice at /setup (the
// customer owes no cash), never on a combined-balance session (codex r2
// P1 — a transfer + record-payment would settle only the anchor while the
// panel advertised the COMBINED total), and never on a WITHDRAWN packet
// invoice (codex r25 P1 — a transfer happens entirely off-platform and
// can't be clawed back). Two further live checks run only once every
// other condition already passed (same short-circuit as before, so a
// non-collectible/save-required/etc. invoice never reaches Stripe): no
// saved-card charge in flight or awaiting reconciliation (codex r5 P1),
// and no attached PaymentIntent Stripe has already moved to
// succeeded/processing (codex r6 P1, inspect-only via prepaid-pi-guard).
//
// NOTE (independent-review P1 round 2, PR #5331): this predicate does NOT
// check estimate-deposit settlement readiness itself — GET /:token already
// refuses the whole page for a pending receipt via withInvoiceDepositSettlement
// before it ever reaches this predicate, so re-checking here would only
// duplicate work on every call and risk a second, unmocked DB read for every
// caller of this shared predicate (pay-v2's own tests mock estimate-deposits
// narrowly). The two ASYNC callers that do NOT run inside that fence —
// fetchZelleEligibility (sms-shadow-drafter.js) and zelleInvoiceStillEligible
// (sms-amount-recheck.js) — run the SAME assertInvoiceDepositSettlementReady
// check themselves, alongside this predicate, so pay-v2's own route behavior
// stays byte-identical while both other callers gain the missing condition.
// `creditWillCoverAnchor`, `hasPreviousBalance`, and `saveRequired` are
// accepted as overrides so THIS route reuses its own already-computed
// values instead of re-querying; an omitted one is derived fresh so a
// caller with only the invoice row (e.g. the SMS drafter) still gets a
// faithful answer.
// `payerOwnedLive` (independent-review P1, round 5, finding 3): a caller
// that already ran its OWN combinedEligibleSiblings against this anchor
// (GET /:token, for the previousBalance itemization) can pass through what
// that call's onPayerResolved callback captured, so this predicate doesn't
// need a second DB/Stripe round trip to learn it. A caller with no
// precomputed siblings (hasPreviousBalance == null) discovers it itself,
// below, via the SAME callback on its own internal call — either path
// denies Zelle the instant the anchor resolves to a LIVE payer, never
// silently falling through as "no previous balance" the way a bare null
// return from combinedEligibleSiblings used to.
async function isZelleTransferEligible(invoice, { creditWillCoverAnchor, hasPreviousBalance, saveRequired, payerOwnedLive, readOnly = false, database = db } = {}) {
  if (!invoice) return false;
  // Phased verdicts, each short-circuiting in the original order (a later live check never runs once an earlier one denies).
  if (await zelleDeniedByInvoiceState(invoice, { creditWillCoverAnchor, saveRequired, database })) return false;
  if (await zelleDeniedByPayerOrSiblings(invoice, { hasPreviousBalance, payerOwnedLive, readOnly, database })) return false;
  if (await zelleDeniedByChargeReconciliation(invoice, readOnly, database)) return false;
  if (await zelleDeniedByPaymentIntent(invoice)) return false;
  return true;
}

// Collectibility, withdrawn packet invoice, saved-method requirement and account credit that settles the whole invoice.
async function zelleDeniedByInvoiceState(invoice, { creditWillCoverAnchor, saveRequired, database }) {
  if (!isInvoiceCollectibleStatus(invoice.status)) return true;
  if (invoiceWithdrawnFromCustomer(invoice)) return true;
  const needsSavedMethod = saveRequired != null ? saveRequired : await invoiceRequiresSavedMethod(invoice, { database });
  if (needsSavedMethod) return true;
  const creditCovers = creditWillCoverAnchor != null ? creditWillCoverAnchor : await invoiceCreditWouldFullyCover(invoice, { database });
  return !!creditCovers;
}

// Combined-balance siblings and a live third-party payer. A caller-supplied hasPreviousBalance skips the sibling lookup; a
// payer-stamped invoice has no siblings to discover. `payerOwned` is set by the resolver callback on the lookup itself.
async function zelleDeniedByPayerOrSiblings(invoice, { hasPreviousBalance, payerOwnedLive, readOnly, database }) {
  let hasPrevBalance = hasPreviousBalance;
  let payerOwned = payerOwnedLive === true;
  if (hasPrevBalance == null) {
    hasPrevBalance = false;
    if (!invoice.payer_id) {
      const PayCombined = require('../services/pay-combined');
      // Codex round-57 P1: a null result means "no siblings" ONLY for `none` / `gate_off`; an incomplete / over-cap / payer-unresolved
      // read is UNVERIFIED sibling debt - a transfer would settle only this invoice - so Zelle is denied (fail closed)
      let siblingsUnverified = false;
      const siblings = await PayCombined.combinedEligibleSiblings(invoice, {
        database,
        reusePaymentIntentId: invoice.stripe_payment_intent_id || null,
        onPayerResolved: () => { payerOwned = true; },
        // (read-only callers - the SMS draft / send rechecks; the pay page GET keeps its existing behavior)
        ...(readOnly ? { onDegrade: (reason) => { if (!['none', 'gate_off'].includes(reason)) siblingsUnverified = true; } } : {}),
        // read-only: the sibling charge-claim fences must not release / promote anything either
        ...(readOnly ? { readOnly: true } : {}),
      });
      hasPrevBalance = siblingsUnverified || !!(siblings && siblings.length);
    }
  }
  return !!(payerOwned || hasPrevBalance);
}

// true when a saved-card charge in flight / awaiting reconciliation suppresses alternate collection; any other error rethrows.
async function zelleDeniedByChargeReconciliation(invoice, readOnly, database = db) {
  try {
    // Codex round-26 P1: callers that only ASK (SMS drafting and send-time rechecks) pass readOnly — the
    // writing default would release a stale pre-submit claim / promote a submitted one while the original
    // charge worker can still commit, exposing a second payment rail. The public pay page GET keeps main's
    // behavior (default, writing) — the same call main's own GET makes.
    if (readOnly) await StripeService.assertNoInvoiceChargeReconciliationPending(invoice.id, database, { readOnly: true });
    else await StripeService.assertNoInvoiceChargeReconciliationPending(invoice.id);
  } catch (err) {
    if (!StripeService.savedCardChargeSuppressesAlternateCollection(err)) throw err;
    return true;
  }
  return false;
}

// An attached PaymentIntent Stripe has already moved to succeeded/processing (inspect-only); an unreadable one denies.
async function zelleDeniedByPaymentIntent(invoice) {
  if (!invoice.stripe_payment_intent_id) return false;
  const verdict = await require('../services/prepaid-pi-guard')
    .guardOpenPaymentIntentForPrepaid(invoice, { inspectOnly: true })
    .catch(() => ({ ok: false }));
  return !verdict.ok;
}

// Live payer-ownership verdict for Zelle visibility (see
// payPageZelleVisibility): null when the invoice is
// verifiably the homeowner's to pay, else the rejection reason.
async function zellePayerOwnership(inv, dbh) {
  // the ONE live payer-ownership verdict (services/invoice-payer-ownership.js), shared with the SMS invoice-status facts
  return require('../services/invoice-payer-ownership').invoicePayerOwnership(inv, dbh);
}

// A received estimate deposit still awaiting invoice reconciliation (the GET's own opening fence, repeated without a lock): 'deposit_pending'.
async function zelleDeniedByDepositSettlement(invoice, dbh) {
  try {
    await require('../services/estimate-deposits').assertInvoiceDepositSettlementReady(dbh, invoice, { lock: false });
    return null;
  } catch (err) {
    if (err?.code === 'DEPOSIT_RECONCILIATION_REQUIRED') return 'deposit_pending';
    throw err;
  }
}

// { reason } when Zelle must be withheld; else { reason: null, invoice: <the fresh row>, projectedCredit }. Order: the PaymentIntent's live
// Stripe state (the one slow await) FIRST, then the fresh row, its DB-side predicate (no caller overrides), the live payer, the projected
// (partial) credit, and LAST the DB fences (deposit settlement, saved-card claim - Codex rounds 69/70/75: no slow await follows a DB read).
async function zelleFinalPass(inv, { dbh, readOnly }) {
  // Codex round-75 P0 (owner ruling: the full DB pass runs AFTER the slow Stripe probes): the attached PaymentIntent's live Stripe state
  // is read FIRST, from the caller's row; every DB read below follows it, and the fresh row must still carry that same PaymentIntent.
  try {
    if (await withTimeout(zelleDeniedByPaymentIntent(inv), ZELLE_ELIGIBILITY_TIMEOUT_MS)) return { reason: 'invoice_changed' };
  } catch { return { reason: 'eligibility_unverifiable' }; }
  let fresh;
  try { fresh = await dbh('invoices').where({ id: inv.id }).first(); } catch { return { reason: 'eligibility_unverifiable' }; }
  if (!fresh) return { reason: 'invoice_not_found' };
  const changed = String(fresh.status || '') !== String(inv.status || '')
    || (fresh.stripe_payment_intent_id || null) !== (inv.stripe_payment_intent_id || null)
    || invoiceAmountDue(fresh) !== invoiceAmountDue(inv);
  if (changed) return { reason: 'invoice_changed' };
  try {
    if (await zelleDeniedByInvoiceState(fresh, { database: dbh })) return { reason: 'invoice_changed' };
    if (await zelleDeniedByPayerOrSiblings(fresh, { readOnly, database: dbh })) return { reason: 'invoice_changed' };
  } catch { return { reason: 'eligibility_unverifiable' }; }
  const owned = await zellePayerOwnership(fresh, dbh);
  if (owned) return { reason: owned };
  let projectedCredit;
  try { projectedCredit = await invoiceProjectedCreditApplied(fresh, { database: dbh }); } catch { return { reason: 'credit_unverifiable' }; }
  // the DB fences as the last reads (Codex round-70 P0s): a received estimate deposit awaiting reconciliation, and a saved-card charge
  // claim (read-only: never releases or promotes anything)
  try {
    const deposit = await zelleDeniedByDepositSettlement(fresh, dbh);
    if (deposit) return { reason: deposit };
    if (await zelleDeniedByChargeReconciliation(fresh, true, dbh)) return { reason: 'invoice_changed' };
  } catch { return { reason: 'eligibility_unverifiable' }; }
  return { reason: null, invoice: fresh, projectedCredit };
}

const ZELLE_ELIGIBILITY_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ZELLE_ELIGIBILITY_TIMEOUT' })), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// STRUCTURAL (independent-review P1, round 5, findings 3 & 4, PR #5331): the
// ONE place that answers "does the pay page offer a Zelle transfer for this
// invoice RIGHT NOW" — folding isZelleTransferEligible's full predicate
// together with the credit-pending withholding PayPageV2.jsx applies on the
// client (hidden until POST /:token/setup answers with the post-credit
// amount; a projection is not a reservation — codex r3 P1) into one function,
// so GET /:token, the drafter's draft-time fetchZelleEligibility, and the
// send-time zelleInvoiceStillEligible recheck can never quietly disagree
// again. `reason` lets GET tell "structurally ineligible" (withhold the
// config entirely, exactly as before this function existed) apart from
// "eligible but a partial credit is pending" (still ride the config, flagged
// `creditPending: true`, so the client can reveal it once /setup resolves
// the real amount) — every OTHER caller only ever wants the plain boolean.
async function payPageZelleVisibility({
  invoiceId = null, invoice = null, dbh = db,
  creditWillCoverAnchor, hasPreviousBalance, saveRequired, payerOwnedLive, readOnly = false,
} = {}) {
  if (!manualPayOptionsFromEnv()) return { visible: false, reason: 'not_configured' };
  const inv = invoice || (invoiceId ? await dbh('invoices').where({ id: invoiceId }).first() : null);
  if (!inv) return { visible: false, reason: 'invoice_not_found' };
  // ONE dedicated ownership step, ALWAYS run for every caller — GET /:token
  // (the pay page), the drafter's draft-time fetch and the send-time recheck —
  // independent of payIncludeBalance / combined-balance gating (Codex round-6
  // pre-push audit P1, owner-approved to cover the pay page too):
  // combinedEligibleSiblings returns null BEFORE resolving a payer when
  // payIncludeBalance is off, and on any resolver error — neither fires
  // onPayerResolved — so relying on it let an UNSTAMPED invoice now owned by a
  // third-party payer through. Stamped payer_id / payer_statement_id ->
  // reject; otherwise the LIVE payer resolver is called directly (the same one
  // combinedEligibleSiblings uses, with throwOnError so an outage is not
  // misread as self-pay). A payer -> 'payer_owned'; a throw or an invoice with
  // no customer to resolve for -> 'payer_unverifiable' (fail closed).
  const ownership = await zellePayerOwnership(inv, dbh);
  if (ownership) return { visible: false, reason: ownership };
  // Codex round-10 P1 (PR #5331): a credit lookup that ERRORS is unknown, not
  // zero — never offer Zelle on an unverifiable credit state (an unseen credit
  // could fully cover the invoice or change the amount). Fail closed.
  let coverage = creditWillCoverAnchor;
  if (coverage == null) {
    try { coverage = await invoiceCreditWouldFullyCover(inv, { database: dbh }); } catch { return { visible: false, reason: 'credit_unverifiable' }; }
  }
  // Pre-push audit P1: isZelleTransferEligible RETHROWS a non-suppression error from
  // the charge-reconciliation check (and any probe below it can throw or hang on
  // Stripe). On the public pay page that must never 500 the page — fail CLOSED:
  // withhold Zelle, log the invoice id only. Bounded so a slow Stripe read cannot
  // stall the page either (the PI inspect also carries its own request timeout).
  let eligible;
  try {
    eligible = await withTimeout(
      isZelleTransferEligible(inv, { creditWillCoverAnchor: coverage, hasPreviousBalance, saveRequired, payerOwnedLive, readOnly, database: dbh }),
      ZELLE_ELIGIBILITY_TIMEOUT_MS,
    );
  } catch (err) {
    logger.warn(`[pay-v2] Zelle eligibility check failed for invoice ${inv.id}: ${err.code || err.name || 'error'}; withholding Zelle`);
    return { visible: false, reason: 'eligibility_unverifiable' };
  }
  if (!eligible) return { visible: false, reason: 'not_eligible' };
  // ONE FINAL FULL PASS (owner ruling 2026-10-02, after Codex rounds 63-66 named one field at a time): after the credit / reconciliation /
  // Stripe awaits, the invoice row is read again and the whole predicate reruns on it with NO caller overrides (zelleFinalPass), ending
  // with the active-collection guards. A change after that is the accepted residual window. A failed read fails closed.
  return finalZelleVerdict(await zelleFinalPass(inv, { dbh, readOnly }));
}
// Finding 4 / Codex round-13: any positive projected (partial) credit withholds Zelle (PayPageV2.jsx's `creditPending && !stripeSetup`),
// and rides the verdict so GET /:token reuses it. Codex round-68 P0: one that covers the WHOLE invoice is full coverage, never pending.
function finalZelleVerdict(final) {
  if (final.reason) return { visible: false, reason: final.reason };
  const { projectedCredit } = final;
  if (projectedCredit > 0 && projectedCredit >= invoiceAmountDue(final.invoice)) return { visible: false, reason: 'credit_covers' };
  if (projectedCredit > 0) return { visible: false, reason: 'credit_pending', projectedCredit };
  return { visible: true, reason: null, projectedCredit };
}

router.get('/:token', async (req, res, next) => {
  try {
    const firstRead = await InvoiceService.getByToken(req.params.token);
    if (!firstRead) return res.status(404).json({ error: 'Invoice not found' });
    // Wait for an already-recording receipt before exposing a balance that
    // can be paid outside Stripe. The reload shares the locked transaction
    // and must not count the same request as another view.
    const data = await require('../services/estimate-deposits').withInvoiceDepositSettlement(
      firstRead.id,
      (trx) => InvoiceService.getByToken(req.params.token, { recordView: false, database: trx }),
    );
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is not individually viewable/payable — it
    // renders on the consolidated statement. Fail closed on the pay surface
    // (receipts stay permanent; the block is here, not in getByToken).
    if (data.payer_statement_id) return res.status(404).json({ error: 'This charge is billed on the monthly statement.' });
    // NOTE: this is an UNAUTHENTICATED public-by-token GET (link previews /
    // scanners hit it). It must stay read-only for money state — account credit
    // is auto-applied from the controlled POST /:token/setup path, never here.

    // Third-party Bill-To: an AP contact opening the emailed pay link must see
    // the payer as "Billed to" (not the homeowner) and must not be offered
    // "save card" (server already refuses to save it onto the homeowner).
    await require('../services/payer').attachToInvoice(data);

    const customer = data.customer || {};
    const lineItems = data.line_items || [];
    const productsApplied = data.products_applied || [];
    const photos = data.service_photos || [];
    const annualPrepayTerm = data.annual_prepay_term || null;
    const annualPrepay = data.annual_prepay
      ? {
          ...data.annual_prepay,
          renewalDecision: annualPrepayTerm?.renewalDecision || null,
        }
      : null;
    const attachments = await InvoiceAttachments.list(data.id).catch((err) => {
      logger.warn(`[pay-v2] attachment list failed for invoice ${data.id}: ${err.message}`);
      return [];
    });

    // Server-authoritative "payment method on file is required" flag —
    // the client locks the consent box from THIS, not the URL. For a
    // credit-covered required-save invoice, captureNeeded makes the
    // method-capture step RESUMABLE: any reload / redirect return
    // re-derives it from live state instead of trusting the one /setup
    // response (Codex #2507 P1 round-3). Two legs: 'prepaid' covers
    // invoices settled before the held-coverage flow shipped; a still-
    // collectible invoice whose credit WOULD fully cover is the held
    // state (round-7 P1 — coverage now applies only after capture).
    // Previous-balance itemization (owner ruling 2026-08-16, SUPERSEDING
    // the earlier "no sibling-invoice data on this surface" P0 from the
    // balance-visibility lane): with GATE_PAY_INCLUDE_BALANCE on, this
    // surface itemizes the customer's other open self-pay invoices —
    // numbers, dates, amounts — and the Pay flow charges the COMBINED
    // total. The owner accepted the forwarded-link disclosure trade-off
    // explicitly (itemized list, not amount-only). Two hard lines remain:
    // sibling TOKENS never ride this payload (one leaked link must not fan
    // out into bearer credentials for other invoices), and the gate off ⇒
    // payload byte-identical to today. Selection = pay-combined.js (the
    // same authority /setup prices from, so what's shown is what's
    // charged); payer-billed anchors and admin-stopped-dunning invoices
    // never appear.
    let previousBalance = null;
    // Independent-review P1 (round 5, finding 3): captured from the SAME
    // combinedEligibleSiblings call below via its onPayerResolved callback —
    // a live-resolved payer (assigned via the scheduled service or the
    // customer default AFTER this invoice was created, so invoices.payer_id
    // is still null) must deny Zelle, not read as "no previous balance,
    // continue" the way a bare null return used to. Threaded into
    // isZelleTransferEligible/payPageZelleVisibility below so this route
    // never re-derives the live resolution a second time.
    let payerOwnedLive = false;
    // Account credit that will FULLY cover the anchor suppresses the
    // combined preview (codex r18 P1): /setup's auto-apply transitions the
    // anchor to prepaid and returns covered_by_credit with NO PaymentIntent
    // — a "Total due today" that included siblings would silently shrink
    // to nothing at Pay time. The siblings stay on their own dunning rails.
    let creditWillCoverAnchor = false;
    try {
      creditWillCoverAnchor = await invoiceCreditWouldFullyCover(data);
    } catch {
      // Unknown, not false: null makes payPageZelleVisibility re-probe and fail
      // closed (credit_unverifiable) instead of offering Zelle on an unseen credit.
      creditWillCoverAnchor = null;
    }
    if (isInvoiceCollectibleStatus(data.status) && !data.payer_id && !creditWillCoverAnchor) {
      const PayCombined = require('../services/pay-combined');
      const siblings = await PayCombined.combinedEligibleSiblings(data, {
        reusePaymentIntentId: data.stripe_payment_intent_id || null,
        onPayerResolved: () => { payerOwnedLive = true; },
      });
      if (siblings?.length) {
        const prevTotalCents = siblings.reduce((sum, inv) => sum + PayCombined.amountDueCents(inv), 0);
        previousBalance = {
          invoices: siblings.map((inv) => ({
            invoiceNumber: inv.invoice_number,
            // NO serviceType (codex r14 P1): /pay/:token is an
            // unauthenticated forwarded bearer surface — the owner-approved
            // exception covers sibling numbers, dates, and amounts only,
            // never the customer's service history.
            serviceDate: inv.service_date,
            dueDate: inv.due_date,
            amountDue: PayCombined.amountDueCents(inv) / 100,
          })),
          total: prevTotalCents / 100,
          combinedTotal: (prevTotalCents + PayCombined.amountDueCents(data)) / 100,
        };
      }
    }

    const getSaveRequired = await invoiceRequiresSavedMethod(data);
    // Off-Stripe tenders (see isZelleTransferEligible for the full
    // predicate and its history) — extracted so every other caller that
    // needs to know "would the pay page offer Zelle for this invoice"
    // (e.g. the SMS real-answers PAYMENT OPTIONS fact) asks the SAME
    // question this route answers, rather than re-deriving it and risking
    // disagreement (independent-review P1).
    //
    // Independent-review P1 (round 3, PR #5331): read the config FIRST —
    // manualPayOptionsFromEnv() is a synchronous env read with no I/O — and
    // run isZelleTransferEligible's async probes (which include
    // assertNoInvoiceChargeReconciliationPending, a DB/Stripe call that can
    // throw) ONLY when Zelle is actually configured. Awaiting the
    // eligibility probe unconditionally let an unrelated reconciliation-
    // check failure 500 this PUBLIC, unauthenticated pay page even with
    // ZELLE_RECIPIENT unset. This restores the pre-#5331 order: with Zelle
    // unset, behavior here is byte-identical to before this lane.
    //
    // Independent-review P1 (round 5, findings 3 & 4): payPageZelleVisibility
    // is now the ONE decision (see its own comment) — this route keeps its
    // exact prior behavior by reading `reason`: 'credit_pending' still rides
    // the config (flagged below) exactly as before this function existed,
    // while any OTHER non-visible reason (not configured, structurally
    // ineligible, and now also the live-payer-owned case) withholds it
    // entirely, same as the old plain-boolean isZelleTransferEligible check.
    const configuredManualPayOptions = manualPayOptionsFromEnv();
    let manualPayOptions = null;
    let visibilityProjectedCredit = null;
    if (configuredManualPayOptions) {
      const zelleVisibility = await payPageZelleVisibility({
        invoice: data,
        creditWillCoverAnchor,
        hasPreviousBalance: !!previousBalance,
        saveRequired: getSaveRequired,
        payerOwnedLive,
      });
      if (zelleVisibility.visible || zelleVisibility.reason === 'credit_pending') {
        // Codex round-61 P1: the recipient is read AGAIN after the eligibility awaits - a ZELLE_RECIPIENT rotated (or removed) while
        // the probes ran must never surface the old destination (removed => no Zelle at all)
        manualPayOptions = manualPayOptionsFromEnv();
        visibilityProjectedCredit = zelleVisibility.projectedCredit ?? null;
      }
    }
    if (manualPayOptions) {
      // Transfer amount = what the invoice owes RIGHT NOW (gross amount due).
      // Partial account credit is applied only when /setup mints (codex r2
      // P1 → r3 P1: a projection is not a reservation — if /setup never runs,
      // the gross is what's owed and what record-payment books). So when
      // credit WILL apply at /setup, flag it: the client withholds the
      // transfer links until /setup answers with the post-credit amount, and
      // never pre-fills either the gross or a projected figure meanwhile.
      // Reuse the projection payPageZelleVisibility already computed (no third
      // credit read); a missing value is unverifiable => withheld, as before.
      const projectedCredit = visibilityProjectedCredit;
      if (projectedCredit == null) {
        // Codex round-10 P1: an unverifiable credit is never read as zero.
        manualPayOptions = null;
      } else {
        manualPayOptions = {
          ...manualPayOptions,
          amountDue: invoiceAmountDue(data),
          ...(projectedCredit > 0 ? { creditPending: true } : {}),
        };
        // The same row the amount came from, so the client can fence a
        // pre-filled transfer against a later admin edit (codex r3 P1).
        manualPayOptions.version = data.updated_at ? new Date(data.updated_at).getTime() : null;
      }
    }

    const getCaptureNeeded = getSaveRequired
      && (data.status === 'prepaid'
        || (isInvoiceCollectibleStatus(data.status) && (await invoiceCreditWouldFullyCover(data))))
      && (await invoiceCaptureNeeded(data));

    // The visit note, screened like every other customer render
    // (context-aggregator.js customerSafeVisitNotes): the reviewed report
    // text only. The invoice
    // keeps the note as it stood when billed (the raw note, on older
    // invoices), so it is screened here with the visit record's own flags; a
    // combined-visit invoice keeps none and shows none.
    const techNotes = data.tech_notes && data.service_record_id
      ? await db('service_records')
        .where({ id: data.service_record_id, customer_id: data.customer_id })
        .first('structured_notes', 'service_data', 'completion_source')
        .then((record) => (record ? customerSafeVisitNotes({ ...record, technician_notes: data.tech_notes }, { projectLine: true }) : null))
        .catch(() => null)
      : null;

    res.json({
      invoice: {
        id: data.id,
        invoiceNumber: data.invoice_number,
        title: data.title,
        status: data.status,
        // Opaque render version (updated_at ms). Delivered invoices are
        // editable (2026-07-17): /setup refuses to mint a PI when the page
        // echoes a version older than the row, so a customer can never
        // confirm a charge against line items an admin has since rewritten.
        version: data.updated_at ? new Date(data.updated_at).getTime() : null,
        saveRequired: getSaveRequired,
        captureNeeded: getCaptureNeeded,
        lineItems,
        subtotal: parseFloat(data.subtotal),
        discountAmount: parseFloat(data.discount_amount),
        discountLabel: data.discount_label,
        taxRate: parseFloat(data.tax_rate),
        taxAmount: parseFloat(data.tax_amount),
        total: parseFloat(data.total),
        // Amount the customer actually pays = total − applied account credit, so
        // the displayed amount matches what Stripe/Terminal charge to the cent.
        // creditApplied drives the "Account credit applied" line.
        amountDue: parseFloat(data.amount_due != null ? data.amount_due : data.total),
        creditApplied: parseFloat(data.credit_applied || 0),
        dueDate: data.due_date,
        paidAt: data.paid_at,
        cardBrand: data.card_brand,
        cardLastFour: data.card_last_four,
        receiptUrl: data.receipt_url,
        notes: data.notes,
        annualPrepay,
        attachments: attachments.map((a) => ({
          id: a.id,
          fileName: a.file_name,
          mimeType: a.mime_type,
          fileSizeBytes: a.file_size_bytes,
          createdAt: a.created_at,
        })),
      },
      service: {
        type: data.service_type,
        date: data.service_date,
        techName: data.tech_name,
        techNotes,
        productsApplied,
        photos,
      },
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email,
        tier: customer.waveguard_tier,
        address: customer.address_line1,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        isCommercial: customer.property_type === 'commercial' || customer.property_type === 'business',
      },
      payer: data.payer
        ? {
            name: data.payer.company_name || data.payer.display_name || null,
            email: data.payer.ap_email || null,
            address: data.payer.billing_address_line1 || null,
            city: data.payer.billing_city || null,
            state: data.payer.billing_state || null,
            zip: data.payer.billing_zip || null,
            poNumber: data.po_number || null,
          }
        // Fail closed: this invoice IS payer-billed (payer_id set) but the payer
        // couldn't be attached (legacy invoice with no snapshot + an inactive/
        // deleted payer row). Serialize a third-party-billed placeholder rather
        // than null, so the pay page does NOT render as self-pay with the
        // homeowner as bill-to (keeps save-card suppressed / billing email blank).
        : data.payer_id
          ? {
              name: 'Third-party payer',
              email: null,
              address: null,
              city: null,
              state: null,
              zip: null,
              poNumber: data.po_number || null,
            }
          : null,
      processor: 'stripe',
      stripe: {
        available: StripeService.isAvailable(),
        publishableKey: stripeConfig.publishableKey || null,
      },
      // Absent (not null) when the gate is off or there is nothing owed —
      // the gate-off payload stays byte-identical to today.
      ...(previousBalance ? { previousBalance } : {}),
      // Off-Stripe tenders (Zelle / Venmo / PayPal) shown under checkout.
      // Absent when no env var is set (kill switch), when the invoice is not
      // collectible, when it requires a saved method, or when account credit
      // covers it — see the manualPayOptions comment above.
      ...(manualPayOptions ? { manualPayOptions } : {}),
      // FAQ accordion under the Pay button (GATE_PAY_PAGE_FAQ). Absent when
      // the gate is off so the gate-off payload stays byte-identical.
      ...(require('../config/feature-gates').gates.payPageFaq ? { payFaq: true } : {}),
    });
  } catch (err) {
    if (err.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
      return res.status(409).json({ error: err.message, reconciliationRequired: true });
    }
    next(err);
  }
});

// =========================================================================
// GET /api/pay/:token/attachments/:attachmentId — token-gated attachment view
// =========================================================================
router.get('/:token/attachments/:attachmentId', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ token: req.params.token }).first('id', 'payer_statement_id');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice's attachments are not individually viewable —
    // it belongs to the consolidated statement. Fail closed.
    if (invoice.payer_statement_id) return res.status(404).json({ error: 'Invoice not found' });
    const attachment = await InvoiceAttachments.getForInvoice(invoice.id, req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    const url = await InvoiceAttachments.signedViewUrl(attachment);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/setup — Create Stripe PaymentIntent for invoice
// =========================================================================
// Codex #4971 r26 P1: a delivered termite-renewal pay link whose parent plan
// has since been cancelled, refunded or moved must not start a payment. Keyed
// on the invoice's own term link, so an ordinary invoice costs no query.
async function rejectIfRenewalNotPayable(invoice, res) {
  if (!invoice?.annual_prepay_term_id) return false;
  const refusal = await require('../services/termite-annual-renewal-charge').renewalPaymentRefusal(invoice);
  if (!refusal) return false;
  res.status(409).json({ error: refusal.message, renewalNotPayable: true });
  return true;
}

// Rendered-version attestation for a save-the-method capture (codex #5434
// r1 P1): the pay page bundles its own copy of the consent text, so every
// request that captures (or prepares to capture) a consent carries the
// CONSENT_VERSION the tab rendered beside its checkbox. A capture that
// attests another version — or none (a bundle from before the attestation
// existed, left open across a copy change) — is refused BEFORE any Stripe
// work with a 409 the page surfaces as "refresh the page", so a tab can
// never be recorded as agreeing to text it did not show. Only when a
// method is actually being saved: a plain one-off payment attests nothing.
function rejectStaleConsentVersion(req, res, saving) {
  if (!saving) return false;
  if (renderedConsentVersionIsCurrent(req.body?.consentTextVersion)) return false;
  res.status(409).json(consentVersionStaleResponse());
  return true;
}

router.post('/:token/setup', async (req, res, next) => {
  let invoice = null;
  try {
    const { saveCard, cardOnly, invoiceVersion, consentTextVersion } = req.body || {};
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    // Stale-render fence: delivered invoices are editable (2026-07-17), and
    // a page opened before an edit still shows the pre-edit line items while
    // stripe_payment_intent_id is null (the edit lock only engages once a PI
    // exists). When the client echoes the version its render came from and
    // it no longer matches the row, refuse the mint — the page reloads to
    // the updated invoice instead of charging against details the customer
    // isn't looking at. Backward-compatible: clients that don't echo a
    // version (older bundles) skip the check, matching today's behavior.
    // This unlocked read is only the cheap early exit — the authoritative
    // recheck runs against the FOR UPDATE row inside the mint transaction
    // (expectedVersion below), closing the check→lock edit window.
    if (
      invoiceVersion != null
      && invoice.updated_at
      && String(new Date(invoice.updated_at).getTime()) !== String(invoiceVersion)
    ) {
      return res.status(409).json({
        error: 'This invoice was just updated — refreshing to the latest version.',
        staleInvoice: true,
      });
    }
    // A committed saved-card claim is a cross-rail fence, not only a guard
    // for repeated saved-card clicks. Do not mint a public PaymentIntent
    // while an off-session charge is active or awaiting reconciliation.
    if (await rejectIfInvoiceCollectionPending(invoice, res)) return;
    if (await rejectIfRenewalNotPayable(invoice, res)) return;
    try {
      assertInvoiceCollectible(invoice);
    } catch (err) {
      // The invoice already flipped to `processing` — an ACH debit in flight.
      // This is the same benign in-progress state as the createInvoicePaymentIntent
      // 409 below, and it can be hit by a fresh-return race (the webhook flips
      // the status between the page's initial GET and this POST). Carry
      // `inProgress: true` so the pay page shows the "bank payment processing"
      // state instead of a red error.
      if (invoice.status === 'processing') {
        return res.status(409).json({ error: err.message, inProgress: true });
      }
      return res.status(400).json({ error: err.message });
    }

    // Required-save invoices force the flag server-side — stripping the URL
    // param or editing the POST body must not produce a recurring signup
    // with no method on file (Codex #2507 P1).
    const requireSave = await invoiceRequiresSavedMethod(invoice);
    // Account credit fully covering a REQUIRED-SAVE invoice must not skip
    // method capture (Codex #2507 P1 round-2) — and must not SETTLE the
    // invoice before capture completes either (round-7 P1): the hold flag
    // makes createInvoicePaymentIntent PROBE full coverage instead of
    // applying it, so an abandoned capture form leaves the invoice
    // collectible, never prepaid-with-nothing-chargeable. The credit
    // applies via settleHeldCoverage after save→consent→enroll. Only the
    // FLAG is computed here — the SetupIntent is minted by POST
    // /:token/capture-setup so a transient mint failure is retryable and
    // the state is re-derivable on every page load (GET's
    // invoice.captureNeeded), never permanently bypassed by a swallowed
    // error (Codex #2507 P1 round-3).
    const holdCoverageForCapture = requireSave && (await invoiceCaptureNeeded(invoice));
    if (rejectStaleConsentVersion(req, res, !!saveCard || requireSave)) return;
    const result = await StripeService.createInvoicePaymentIntent(invoice.id, {
      saveCard: !!saveCard || requireSave,
      cardOnly: !!cardOnly,
      holdCoverageForCapture,
      expectedVersion: invoiceVersion,
      // Stamped into the PaymentIntent's metadata beside save_card_opt_in:
      // the webhook mirror records the consent only under a current stamp.
      consentTextVersion,
      // Combined full-balance charge (GATE_PAY_INCLUDE_BALANCE): the mint
      // decides server-side whether siblings ride this PI; gate off or no
      // open balance ⇒ identical to today.
      includeOpenBalance: true,
    });
    const captureNeeded = !!result.covered_by_credit && holdCoverageForCapture;
    // Post-mint row version (codex r5 P2): partial account credit applied at
    // mint advances updated_at, so the pay page's transfer fence must compare
    // a later click against THIS version, not the GET's — else the first
    // Open Venmo/PayPal after setup always false-rejects. A failed read
    // leaves it null (client falls back to the GET version: safe direction).
    const postMintRow = await db('invoices').where({ id: invoice.id }).first('updated_at').catch(() => null);
    const postMintVersion = postMintRow?.updated_at ? new Date(postMintRow.updated_at).getTime() : null;

    res.json({
      version: postMintVersion,
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      amount: result.amount,
      baseAmount: result.baseAmount,
      cardSurchargeRate: result.cardSurchargeRate,
      // Combined breakdown when this PI charges the full balance — the pay
      // page renders its totals from THIS, never client math.
      ...(result.combined ? { combined: result.combined } : {}),
      publishableKey: stripeConfig.publishableKey,
      // Account credit may have fully covered the invoice at setup (no PI minted) —
      // surface it so the pay page can show "covered" instead of a card form.
      coveredByCredit: !!result.covered_by_credit,
      status: result.status,
      // Required-save + covered + nothing chargeable on file → the client
      // runs the capture step (POST /capture-setup) before the covered state.
      captureNeeded,
    });
  } catch (err) {
    if (err.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
      return res.status(409).json({ error: err.message, reconciliationRequired: true });
    }
    // A 409 means the invoice already has a live PaymentIntent that setup could
    // neither reuse nor replace. Two cases, distinguished by `inProgress` (set by
    // createInvoicePaymentIntent only when money is genuinely in flight — a live
    // payment row or a `processing` PI):
    //   • inProgress  → an ACH bank debit still `processing`, an ACH micro-deposit
    //     verification still in `requires_action` (the customer is mid bank-verify,
    //     not stuck), or a reload / bank-redirect return. NOT a failure: no admin
    //     alert, and the pay page shows the customer the benign bank state.
    //   • !inProgress → an alert-worthy mismatch an operator must see: a PI
    //     reporting `succeeded` while the invoice is still unpaid (a lost/failed
    //     reconciliation webhook), or a stale unconfirmed PI that could not be
    //     canceled for replacement because it just raced into a live state. A
    //     card PI merely stuck in requires_action is no longer a 409 — setup now
    //     cancels and re-mints it so the customer can pay (no operator needed).
    if (err.statusCode === 409) {
      // A stale-render refusal from the in-txn version recheck is the same
      // benign reload-and-retry as the unlocked pre-check above — no
      // operator alert, the page just refreshes to the updated invoice.
      // staleBalance (a sibling changed under the combined verification) is
      // the same benign self-recovering race (codex r12 P2).
      if (!err.inProgress && !err.staleInvoice && !err.staleBalance) {
        // Never log the raw pay-link token — it is the bearer credential for
        // this invoice and errors.log is broadly readable. When the invoice id
        // is unavailable, fall back to a masked suffix that still aids
        // correlation without disclosing the token.
        const tokenHint = req.params.token ? `tok…${String(req.params.token).slice(-4)}` : 'unknown';
        logger.warn(`[pay-v2] Setup 409 (recoverable conflict) for invoice ${invoice?.id || tokenHint}: ${err.message}`);
        reportBillPaymentError(req, {
          invoice,
          phase: 'setup',
          methodCategory: 'card',
          error: err,
          statusCode: 409,
          metadata: { save_card: !!req.body?.saveCard, recoverable_conflict: true },
        });
      }
      return res.status(409).json({
        error: err.message,
        inProgress: !!err.inProgress,
        microdepositPending: !!err.microdepositPending,
        microdeposit: err.microdeposit || null,
        savedCardPending: !!err.savedCardPending,
        reconciliationRequired: !!err.reconciliationRequired,
        staleInvoice: !!err.staleInvoice,
        // Combined full-balance flow: a sibling invoice changed between the
        // page render and the mint — same reload-and-retry contract as
        // staleInvoice, surfaced separately for clarity.
        staleBalance: !!err.staleBalance,
      });
    }
    logger.error(`[pay-v2] Setup error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'setup',
      methodCategory: 'card',
      error: err,
      statusCode: err.statusCode || 500,
      metadata: { save_card: !!req.body?.saveCard },
    });
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/update-amount — Adjust PI for selected payment method
// No surcharge at this stage — both card and ACH stay at base amount.
// Surcharge is added at /quote + /finalize after PM funding is known.
// =========================================================================
router.post('/:token/update-amount', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentIntentId, methodCategory, saveCard, consentTextVersion } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    // An older pay-page PI can outlive the page that minted it. Fence every
    // route that can mutate that PI while a saved-card collection owns the
    // invoice, not only the route that creates new PIs.
    if (await rejectIfInvoiceCollectionPending(invoice, res)) return;
    if (await rejectIfRenewalNotPayable(invoice, res)) return;
    try {
      assertInvoiceCollectible(invoice);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    // Required-save invoices force the flag server-side (see /setup).
    const savingOnUpdate = !!saveCard || (await invoiceRequiresSavedMethod(invoice));
    if (rejectStaleConsentVersion(req, res, savingOnUpdate)) return;
    const result = await StripeService.updateInvoicePaymentIntentMethod(
      invoice.id,
      paymentIntentId,
      methodCategory,
      { saveCard: savingOnUpdate, consentTextVersion },
    );

    res.json(result);
  } catch (err) {
    if (err.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
      return res.status(409).json({ error: err.message, reconciliationRequired: true });
    }
    // 409 = expected race/in-flight state (e.g. trying to switch tender while
    // a payment is already processing). Surface it to the customer without
    // raising an admin bill-payment-error alert. staleBalance = a combined
    // allocation drifted under the locked re-verification — same
    // reload-and-retry contract as /setup.
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, staleBalance: !!err.staleBalance });
    }
    logger.error(
      `[pay-v2] Update-amount error `
      + `(PI ${req.body?.paymentIntentId || 'missing'}): ${err.type || 'Error'} — ${err.message}`
      + `${err.code ? ` [code=${err.code}]` : ''}`
      + `${err.param ? ` [param=${err.param}]` : ''}`,
    );
    reportBillPaymentError(req, {
      invoice,
      phase: 'update_amount',
      methodCategory: req.body?.methodCategory,
      paymentIntentId: req.body?.paymentIntentId,
      error: err,
      statusCode: 400,
      metadata: { save_card: !!req.body?.saveCard },
    });
    res.status(400).json({ error: 'Could not update payment total. Please refresh and try again, or call (941) 297-5749.' });
  }
});

// =========================================================================
// POST /api/pay/:token/quote — Get surcharge quote for a specific PM
// =========================================================================
router.post('/:token/quote', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    if (await rejectIfInvoiceCollectionPending(invoice, res)) return;
    if (await rejectIfRenewalNotPayable(invoice, res)) return;
    try {
      assertInvoiceCollectible(invoice);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.quoteInvoiceSurcharge(invoice.id, paymentMethodId);
    res.json(result);
  } catch (err) {
    logger.error(`[pay-v2] Quote error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'quote',
      methodCategory: 'card',
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/finalize — Confirm payment with surcharge applied
// =========================================================================
router.post('/:token/finalize', async (req, res, next) => {
  let invoice = null;
  try {
    const { quoteToken, saveCard, consentTextVersion } = req.body || {};
    if (!quoteToken) return res.status(400).json({ error: 'quoteToken required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is payable only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    if (await rejectIfInvoiceCollectionPending(invoice, res)) return;
    if (await rejectIfRenewalNotPayable(invoice, res)) return;
    try {
      assertInvoiceCollectible(invoice);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    // Required-save invoices force the flag server-side (see /setup).
    // Codex #4971 r26 P1: a termite renewal's payment is finalized UNDER the
    // renewal gate, re-checked there (an ordinary invoice runs straight
    // through).
    const finalizeOptions = { saveCard: !!saveCard || (await invoiceRequiresSavedMethod(invoice)), consentTextVersion };
    if (rejectStaleConsentVersion(req, res, finalizeOptions.saveCard)) return;
    let result;
    try {
      result = await require('../services/termite-annual-renewal-charge')
        .withRenewalPaymentClearance(invoice, () => StripeService.finalizeInvoicePayment(invoice.id, quoteToken, finalizeOptions));
    } catch (clearanceErr) {
      if (clearanceErr && clearanceErr.code === 'RENEWAL_NOT_PAYABLE') {
        return res.status(409).json({ error: clearanceErr.message, renewalNotPayable: true });
      }
      throw clearanceErr;
    }
    res.json(result);
  } catch (err) {
    if (err.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
      return res.status(409).json({ error: err.message, reconciliationRequired: true });
    }
    logger.error(`[pay-v2] Finalize error: ${err.message}`);
    if (err.statusCode === 409 && err.savedCardPending) {
      return res.status(409).json({
        error: err.message,
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired: !!err.reconciliationRequired,
      });
    }
    // Expected races (the consent-stamp fence, combined-balance drift): the
    // page reloads to the live session — same contract as /setup and
    // /update-amount, no admin bill-payment-error alert.
    if (err.statusCode === 409 && err.staleBalance) {
      return res.status(409).json({ error: err.message, staleBalance: true });
    }
    reportBillPaymentError(req, {
      invoice,
      phase: 'finalize',
      methodCategory: 'card',
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
      metadata: { save_card: !!req.body?.saveCard },
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/confirm — Confirm Stripe payment for invoice
// (Legacy — kept for ACH confirmation and Express Checkout which skip /finalize)
// =========================================================================
router.post('/:token/confirm', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice is collected only via its consolidated statement.
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'This charge is billed on the monthly statement; pay the statement, not the individual invoice.' });
    }
    if (await rejectIfInvoiceCollectionPending(invoice, res, { recordExistingPayment: true })) return;
    if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(invoice.status || '').toLowerCase())) {
      try {
        assertInvoiceCollectible(invoice);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    if (invoice.status === 'prepaid') return res.status(400).json({ error: 'Invoice is already prepaid' });
    // UNCONDITIONAL (codex r25 P1): the assertion above runs only for the
    // terminal statuses, and a withdrawn invoice is by construction not one of
    // them — it keeps `sent`/`viewed`/`overdue` so the homeowner's existing
    // link stays resolvable. Making assertInvoiceCollectible row-aware
    // therefore did nothing here, and a PaymentIntent minted before Bill-To
    // moved could still settle customer funds against payer-owned debt.
    // Checked after the paid/prepaid replies so a settled row keeps reporting
    // its own reason (and confirmInvoicePayment keeps returning the recorded
    // payment for a replayed PI).
    try {
      assertInvoiceNotWithdrawnFromCustomer(invoice);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (invoice.stripe_payment_intent_id
      && String(invoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
      return res.status(409).json({ error: 'Invoice has a different active payment' });
    }

    const paymentRecord = await StripeService.confirmInvoicePayment(invoice.id, paymentIntentId);

    // Card payments are paid immediately. ACH bank payments sit in
    // `processing` until Stripe emits payment_intent.succeeded, so the
    // webhook sends the receipt after funds clear. A COMBINED settle
    // already enqueued per-invoice receipts inside
    // settleCombinedPaymentIntent — skip the anchor enqueue here or the
    // customer gets the anchor's receipt twice.
    const recordMeta = (() => {
      try {
        return typeof paymentRecord.metadata === 'string'
          ? JSON.parse(paymentRecord.metadata)
          : (paymentRecord.metadata || {});
      } catch { return {}; }
    })();
    if (paymentRecord.status === 'paid') {
      if (!recordMeta.combined_payment) {
        await ReceiptDeliveryQueue.enqueueReceiptDelivery({
          invoiceId: invoice.id,
          stripePaymentIntentId: paymentIntentId,
          source: 'pay_confirm',
          // The Pay page is always the customer's own payment — the
          // receipt sends at any hour (owner ruling 2026-08-29).
          customerInitiated: true,
        });
        ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain({ delayMs: 1000, limit: 5 });
      }
      // Fire-and-forget: release any payment-held WDO report gated on this
      // invoice (60s interval is the fallback).
      require('../services/project-report-hold').scheduleHoldReleaseSweep({ delayMs: 1500 });
    }

    res.json({
      success: true,
      payment: {
        id: paymentRecord.id,
        amount: parseFloat(paymentRecord.amount),
        status: paymentRecord.status,
      },
    });
  } catch (err) {
    logger.error(`[pay-v2] Confirm error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'confirm',
      methodCategory: req.body?.methodCategory || invoice?.payment_method,
      paymentIntentId: req.body?.paymentIntentId,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/consent — Record save-payment-method authorization
//
// Called by the client right after a successful confirmPayment when the
// customer ticked the save-payment-method box. The Stripe webhook will
// create the payment_methods row asynchronously; this endpoint only
// records the consent (verbatim copy + version + IP/UA) and leaves the
// FK to payment_methods null for the webhook to back-fill.
//
// Method type (card vs ACH) is derived server-side from the invoice's
// own Stripe PaymentIntent, not from the request body. We also verify
// that the client-submitted stripePaymentMethodId is the same PM the
// PaymentIntent actually charged — that defends against a tampered
// client submitting an unrelated PM id. The endpoint fails closed if
// any of those checks can't be confirmed, since recording the wrong
// authorization variant defeats the entire snapshot audit trail.
// =========================================================================
router.post('/:token/consent', async (req, res, next) => {
  let invoice = null;
  try {
    // stripePaymentMethodId is OPTIONAL (Codex #2507 P1 round-3): every
    // verification below keys off the invoice's OWN PaymentIntent, so the
    // body value is only a tamper cross-check when supplied. Redirect-return
    // payments (ACH bank auth, 3DS) post an empty body — the page that held
    // the pm id unloaded at redirect, but the PI is the authority anyway.
    const { stripePaymentMethodId, methodCategory } = req.body || {};

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoiceWithdrawnFromCustomer(invoice)) {
      // Same rule as the collection seams (Codex #4311 r33 P1): a withdrawn
      // invoice must not enroll the homeowner's method for the debt.
      return res.status(409).json({ error: 'This invoice is billed to a third-party payer', code: 'invoice_withdrawn_from_customer' });
    }
    if (!invoice.customer_id) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Invoice has no customer',
        statusCode: 400,
      });
    }
    if (!invoice.stripe_payment_intent_id) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        message: 'Invoice has no PaymentIntent - cannot verify payment method',
        statusCode: 409,
      });
    }

    let pi;
    try {
      pi = await StripeService.retrievePaymentIntent(invoice.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
    } catch (err) {
      logger.error(`[pay-v2] PI retrieve failed for consent on invoice ${invoice.id}: ${err.message}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        error: err,
        statusCode: 502,
        clientMessage: 'Could not verify payment with Stripe',
      });
    }
    if (!pi) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Payment processing temporarily unavailable',
        statusCode: 503,
      });
    }

    if (!pi.payment_method) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'PaymentIntent has no payment method to record consent for',
        statusCode: 409,
      });
    }
    if (stripePaymentMethodId && pi.payment_method !== stripePaymentMethodId) {
      logger.warn(`[pay-v2] Consent PM mismatch: client=${stripePaymentMethodId} pi.payment_method=${pi.payment_method} invoice=${invoice.id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'PaymentMethod does not match the invoice charge',
        statusCode: 409,
        metadata: { stripe_payment_method_id: stripePaymentMethodId },
      });
    }
    // The verified pm is the PI's own — the body value (when present) was
    // only a cross-check.
    const verifiedStripePmId = pi.payment_method;

    // PI status acceptable for consent: succeeded (cards / wallets) or
    // processing (ACH, which clears asynchronously). Anything else means
    // the customer hasn't actually authorized a charge against this PM
    // on this invoice yet.
    if (pi.status !== 'succeeded' && pi.status !== 'processing') {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: `PaymentIntent not in a consent-eligible state (status=${pi.status})`,
        statusCode: 409,
      });
    }

    // The customer must have opted to save the payment method when the
    // PI was set up. Both signals are written together by stripe.js
    // when saveCard is true on /setup or /update-amount:
    // setup_future_usage becomes 'off_session' and metadata.save_card_opt_in
    // becomes 'true'. Without those, a tampered client could otherwise
    // call /consent after any one-time payment and fabricate an
    // authorization row that the customer never actually agreed to.
    const optedIn = pi.setup_future_usage === 'off_session'
      && pi?.metadata?.save_card_opt_in === 'true';
    if (!optedIn) {
      // No opt-in on the PI = nothing to record, and NOT an error: the
      // redirect-return handler posts here on every successful redirect
      // (the page that knew the checkbox state unloaded), so a plain
      // one-time 3DS/bank payment reaching this branch is normal — a 409
      // alert per non-save redirect would flood admin reconciliation with
      // false alarms (Codex #2507 round-5 P2). A tampered client gets the
      // same silent refusal: nothing is recorded either way.
      logger.info(`[pay-v2] Consent skipped — PI ${pi.id} not configured for save-on-file (setup_future_usage=${pi.setup_future_usage}, save_card_opt_in=${pi?.metadata?.save_card_opt_in})`);
      return res.json({ success: false, skipped: true, reason: 'not_opted_in' });
    }
    // The consent text the customer read is the one the tab that MINTED the
    // opt-in attested (codex #5434 r1 P1): /setup and /update-amount stamped
    // that version into the PI beside save_card_opt_in. The stamp — never
    // the posting bundle's constant (a redirect return posts from a freshly
    // loaded, possibly newer bundle) — must be this server's current
    // version; a stale or absent stamp (an opt-in minted under older copy)
    // is refused, nothing is recorded, and the webhook mirror applies the
    // same rule. The payment itself already settled; only the saved-method
    // authorization is withheld.
    if (!renderedConsentVersionIsCurrent(pi?.metadata?.[CONSENT_VERSION_METADATA_KEY])) {
      logger.warn(`[pay-v2] Consent refused — PI ${pi.id} opt-in stamped consent text version ${pi?.metadata?.[CONSENT_VERSION_METADATA_KEY] || 'absent'}, not the current one (invoice ${invoice.id})`);
      return res.status(409).json(consentVersionStaleResponse());
    }

    // Prefer the verified charge.payment_method_details.type — that's
    // the method that actually ran. Fall back to pi.payment_method_types
    // only when there's no charge yet (rare for processing ACH).
    const pmdType = pi.latest_charge?.payment_method_details?.type || null;
    const fallbackType = Array.isArray(pi.payment_method_types) && pi.payment_method_types.length === 1
      ? pi.payment_method_types[0]
      : null;
    const verifiedMethodType = pmdType || fallbackType;
    if (!verifiedMethodType) {
      logger.warn(`[pay-v2] Could not determine method type for consent on invoice ${invoice.id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Could not determine payment method type',
        statusCode: 409,
      });
    }

    // Mirror the method into payment_methods OURSELVES before recording
    // consent + enrolling (Codex #2507 round-7 P1): deferring to the
    // save-card webhook made method_not_found a "normal" outcome — but the
    // webhook may have already run and FAILED to persist, and this
    // response is the customer's only signal. Idempotent lookup-first like
    // /setup-complete (stripe_payment_method_id is unique); ownership
    // fails closed. The pm id is server-verified from the invoice's own
    // PaymentIntent above, never the request body.
    let saved = await db('payment_methods').where({ stripe_payment_method_id: verifiedStripePmId }).first();
    if (saved && saved.customer_id !== invoice.customer_id) {
      logger.warn(`[pay-v2] consent pm ownership mismatch: pm ${verifiedStripePmId} belongs to ${saved.customer_id}, invoice customer ${invoice.customer_id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Payment method belongs to another account',
        statusCode: 409,
      });
    }
    // OWNERSHIP IMMEDIATELY BEFORE THE WRITES (Codex #4311 r39 P0): the check
    // at the top of this route ran several awaits and a Stripe round-trip
    // ago. Packet-aware, so a payer on a sibling billed member counts, and
    // fail-closed on an unreadable row. The CONSENT row below is written in
    // one transaction with this judgement (local audit): a withdrawal that
    // commits mid-request cannot leave a recorded authorization behind.
    if (await require('../services/visit-completion-packets').invoicePayerOwnedNow(invoice.id)) {
      return res.status(409).json({
        error: 'This invoice is billed to a third-party payer',
        code: 'invoice_withdrawn_from_customer',
      });
    }
    if (!saved) {
      saved = await StripeService.savePaymentMethod(invoice.customer_id, verifiedStripePmId, {
        enableAutopay: false,
        // enrollConsentedMethod owns the default decision (claims it only
        // when no healthy method is already in charge).
        makeDefault: false,
      });
    }

    // The consent row and the ownership judgement share ONE transaction
    // (local audit on r39): a Bill-To assignment committing between an
    // unlocked check and this insert would otherwise leave a recorded
    // authorization against payer-owned debt. The Stripe attach above cannot
    // join a database transaction — an attached-but-unconsented,
    // unenrolled method is inert — so the fence is drawn here, around the
    // authorization itself.
    const Packets = require('../services/visit-completion-packets');
    // An ACH debit that is still PROCESSING must not enroll yet (Codex
    // #2507 round-9 P2): the status guard above deliberately admits
    // 'processing' so the consent snapshot is recorded while the customer
    // is present, but enrolling now would make a brand-new bank account
    // the default autopay method days before its FIRST debit has cleared
    // — completion/cron charges could stack debits on an account that
    // may still bounce. The consent row is durable; the succeeded
    // webhook's save-card mirror finds it (hasConsentFor) and completes
    // enrollment after the money actually lands. Cards never sit in
    // 'processing', so this defers bank tenders only.
    const enrollmentDeferred = verifiedMethodType === 'us_bank_account' && pi.status !== 'succeeded';
    // CONSENT *AND* ENROLLMENT UNDER ONE OWNERSHIP JUDGEMENT (Codex #4311
    // r46 P0): they used to commit in separate transactions, so a Bill-To
    // assignment landing between them left the immutable consent row behind
    // while the request answered 409. enrollConsentedMethod runs in savepoint
    // mode on this transaction, so a `payer_billed` refusal rolls the consent
    // back with it. (The Stripe attach above cannot join a database
    // transaction — an attached-but-unconsented, unenrolled method is inert.)
    const PAYER_BILLED_ROLLBACK = Symbol('payer_billed_rollback');
    let consentRefusedForPayer = false;
    let enrollment = null;
    let row;
    try {
      row = await db.transaction(async (trx) => {
        // The customer row FOR UPDATE first (local audit on r46): the
        // ownership check takes it FOR SHARE and the enrollment then upgrades
        // the same row to FOR UPDATE — two of these transactions holding
        // SHARE would deadlock on that upgrade. Taking the stronger lock up
        // front keeps the customer-before-member order intact.
        await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');
        if (await Packets.invoicePayerOwnedNow(invoice.id, trx)) throw PAYER_BILLED_ROLLBACK;
        const created = await ConsentService.recordConsent({
          customerId: invoice.customer_id,
          paymentMethodId: saved.id,
          stripePaymentMethodId: verifiedStripePmId,
          source: 'pay_page',
          methodType: verifiedMethodType,
          ip: req.ip,
          userAgent: req.get('user-agent') || null,
          database: trx,
        });
        if (enrollmentDeferred) return created;
        const { enrollConsentedMethod } = require('../services/autopay-enrollment');
        enrollment = await enrollConsentedMethod({
          customerId: invoice.customer_id,
          paymentMethodId: saved.id,
          source: 'save_card_consent',
          // The invoice's visit scopes the in-lock payer check (#3395 r14 P1):
          // a self_pay_override visit on a payer-billed account is
          // customer-paid — the account-level fallback would refuse.
          scheduledServiceId: invoice.scheduled_service_id || null,
          // …and the invoice itself, so the enrollment re-judges the
          // withdrawal and the PACKET's live owner under this transaction.
          invoiceId: invoice.id,
          dbh: trx,
        });
        if (enrollment?.reason === 'payer_billed') throw PAYER_BILLED_ROLLBACK;
        return created;
      });
    } catch (txErr) {
      if (txErr !== PAYER_BILLED_ROLLBACK) throw txErr;
      consentRefusedForPayer = true;
    }
    if (consentRefusedForPayer) {
      return res.status(409).json({
        error: 'This invoice is billed to a third-party payer',
        code: 'invoice_withdrawn_from_customer',
      });
    }
    if (enrollmentDeferred) {
      logger.info(`[pay-v2] Consent recorded for processing ACH PI ${pi.id} (invoice ${invoice.id}) — enrollment deferred to the succeeded webhook`);
      return res.json({ success: true, consentId: row.id, version: row.consent_text_version, enrollmentDeferred: true });
    }

    // Complete consent-gated autopay enrollment (Codex #2507 P1): when
    // Stripe's payment_intent.succeeded beat this POST the method sits
    // saved-but-unenrolled — the enrollment above (inside the consent
    // transaction) is then the ONLY path that flips the autopay flags, so an
    // enrollment failure must FAIL the request (Codex #2507 round-5 P1): the
    // client retries /consent once and flags consent_failed on the receipt,
    // exactly like a consent-record failure — never a silent success with no
    // Auto Pay. With the mirror above, method_not_found is no longer a normal
    // outcome (round-7 P1) — the row was just ensured, so it too fails.
    // The enrollment ran in savepoint mode, so its confirmation email is
    // handed back for the caller to fire AFTER the commit (local audit on
    // r46) — inside the transaction it could have outlived a rollback.
    if (typeof enrollment?.sendEnrollmentConfirmation === 'function') {
      await enrollment.sendEnrollmentConfirmation();
    }
    if (enrollment?.reason === 'method_not_found') {
      throw new Error('Saved payment method could not be enrolled');
    }
    // A Bill-To change that beat the enrollment refuses the REQUEST (Codex
    // #4311 r39 P0): reporting success here would tell the customer Auto Pay
    // is on for an invoice that is no longer theirs.
    if (enrollment?.reason === 'payer_billed') {
      return res.status(409).json({
        error: 'This invoice is billed to a third-party payer',
        code: 'invoice_withdrawn_from_customer',
      });
    }

    res.json({ success: true, consentId: row.id, version: row.consent_text_version });
  } catch (err) {
    logger.error(`[pay-v2] Consent record failed: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'consent',
      methodCategory: req.body?.methodCategory,
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/capture-setup — Mint the covered-by-credit capture
// SetupIntent (Codex #2507 P1 round-3: minted on demand + retryable, never
// inline-swallowed in /setup; the need is re-derived server-side on every
// call so a stale client can't force capture that's no longer needed).
// =========================================================================
router.post('/:token/capture-setup', async (req, res) => {
  let invoice = null;
  try {
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) return res.status(400).json({ error: 'Invoice has no customer' });
    // A WITHDRAWN invoice funds nothing (Codex #4311 r33 P1): it keeps a
    // collectible status and a NULL payer_id, so the required-save check
    // still approves it and the homeowner's method would be saved — and
    // enrolled for Auto Pay — against debt that now belongs to AP.
    if (invoiceWithdrawnFromCustomer(invoice)) {
      return res.status(409).json({ error: 'This invoice is billed to a third-party payer', code: 'invoice_withdrawn_from_customer' });
    }
    // Fail closed: capture exists solely for the required-save +
    // credit-covered state — any other invoice/token must not be usable to
    // start attaching methods to the account.
    if (!(await invoiceRequiresSavedMethod(invoice))) {
      return res.status(409).json({ error: 'This invoice does not require a saved payment method' });
    }
    // 'prepaid' = invoices settled before the held-coverage flow; a
    // collectible invoice whose credit would fully cover is the HELD
    // state (Codex #2507 round-7 P1 — coverage applies only after
    // capture). Anything else can't be in a capture flow.
    const heldCoverage = invoice.status !== 'prepaid'
      && isInvoiceCollectibleStatus(invoice.status)
      && (await invoiceCreditWouldFullyCover(invoice));
    if (invoice.status !== 'prepaid' && !heldCoverage) {
      return res.status(409).json({ error: 'Capture applies only to credit-covered invoices' });
    }
    if (!(await invoiceCaptureNeeded(invoice))) {
      // A chargeable method landed since /setup held the coverage (webhook
      // race, another tab) — the capture step is moot but the held credit
      // still has to settle the invoice, or it stays open forever. Surface
      // the settle result like /setup-complete does (Codex #2507 round-9
      // P2): settled:false = the credit shrank after the hold and the
      // invoice is still payable — the client must reload into the pay
      // flow, never show "nothing due" against a collectible invoice.
      if (heldCoverage) {
        const settle = await StripeService.settleHeldCoverage(invoice.id);
        return res.json({ alreadyChargeable: true, settled: settle.settled || settle.alreadySettled });
      }
      return res.json({ alreadyChargeable: true });
    }
    // An unhealthy customer-level ACH state (needs_verification/suspended)
    // blocks bank collection regardless of a fresh bank method — offering
    // us_bank_account here would capture a method customerOnAutopay keeps
    // refusing (Codex #2507 P1 round-3). Card-only until the bank state
    // clears.
    let methodTypes = 'card_or_bank';
    try {
      const achRow = await db('customers').where({ id: invoice.customer_id }).first('ach_status');
      if (achRow?.ach_status && achRow.ach_status !== 'active') methodTypes = 'card';
    } catch { /* fail toward card_or_bank */ }
    // The capture form renders the (locked) consent beside the Payment
    // Element: the tab attests the version it renders, the mint stamps it,
    // and /setup-complete + the covered_capture webhook record only under a
    // current stamp (codex #5434 r1 P1).
    if (rejectStaleConsentVersion(req, res, true)) return;
    const setup = await StripeService.createSetupIntent(invoice.customer_id, methodTypes, {
      metadata: {
        purpose: 'covered_capture',
        invoice_id: String(invoice.id),
        [CONSENT_VERSION_METADATA_KEY]: String(req.body.consentTextVersion),
      },
    });
    res.json({
      clientSecret: setup.clientSecret,
      setupIntentId: setup.setupIntentId,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    logger.error(`[pay-v2] capture-setup failed for invoice ${invoice?.id || 'unknown'}: ${err.message}`);
    res.status(502).json({ error: 'Could not start the payment method setup — please try again' });
  }
});

// =========================================================================
// POST /api/pay/:token/setup-complete — Persist a method captured via the
// covered-by-credit SetupIntent flow (Codex #2507 P1 round-2).
//
// Only meaningful for required-save invoices: /capture-setup minted the
// SetupIntent because account credit fully covered the invoice (no PI, so
// the normal webhook save-card mirror never fires) and nothing chargeable
// was on file. Verification is server-side and fails closed: the
// SetupIntent must have succeeded, must belong to this invoice's customer
// (waves_customer_id metadata stamped at mint), and must carry a payment
// method. Mirrors the portal add-card route: save → consent snapshot →
// consent-gated enrollment. IDEMPOTENT (Codex #2507 P2 round-3): a retry
// after a partial first attempt reuses the already-mirrored
// payment_methods row instead of re-inserting into a unique column. The
// setup_intent.succeeded webhook runs the same completion for redirects /
// async bank verification the browser never finishes.
// =========================================================================
router.post('/:token/setup-complete', async (req, res) => {
  let invoice = null;
  try {
    const { setupIntentId } = req.body || {};
    if (!setupIntentId) return res.status(400).json({ error: 'setupIntentId required' });
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) return res.status(400).json({ error: 'Invoice has no customer' });
    if (invoiceWithdrawnFromCustomer(invoice)) {
      return res.status(409).json({ error: 'This invoice is billed to a third-party payer', code: 'invoice_withdrawn_from_customer' });
    }
    // Fail closed: this endpoint exists solely to satisfy the required-save
    // rule — a non-required invoice token must not be usable to attach
    // methods to the account.
    if (!(await invoiceRequiresSavedMethod(invoice))) {
      return res.status(409).json({ error: 'This invoice does not require a saved payment method' });
    }

    const setupIntent = await StripeService.retrieveSetupIntent(setupIntentId, {
      expand: ['payment_method'],
    });
    const pmObject = setupIntent?.payment_method || null;
    const stripePmId = typeof pmObject === 'string' ? pmObject : pmObject?.id;
    if (!setupIntent || setupIntent.status !== 'succeeded' || !stripePmId) {
      return res.status(409).json({
        error: 'Payment method setup is not complete.',
        setupIntentStatus: setupIntent?.status || 'unknown',
        microdepositPending: setupIntent?.next_action?.type === 'verify_with_microdeposits',
      });
    }
    if (setupIntent.metadata?.waves_customer_id !== String(invoice.customer_id)) {
      logger.warn(`[pay-v2] setup-complete customer mismatch: SI ${setupIntentId} meta=${setupIntent.metadata?.waves_customer_id} invoice customer=${invoice.customer_id}`);
      return res.status(409).json({ error: 'Setup does not belong to this invoice' });
    }
    // The consent text the customer read is the version the tab that MINTED
    // this capture attested (/capture-setup stamped it); a stale or absent
    // stamp is refused before any save — same rule as /consent and the
    // covered_capture webhook (codex #5434 r1 P1).
    if (!renderedConsentVersionIsCurrent(setupIntent.metadata?.[CONSENT_VERSION_METADATA_KEY])) {
      logger.warn(`[pay-v2] setup-complete refused — SI ${setupIntentId} stamped consent text version ${setupIntent.metadata?.[CONSENT_VERSION_METADATA_KEY] || 'absent'}, not the current one (invoice ${invoice.id})`);
      return res.status(409).json(consentVersionStaleResponse());
    }

    // Idempotent save: stripe_payment_method_id is unique — a retry after a
    // partial first attempt (saved but consent/enrollment failed) must
    // continue with the existing row, never re-insert.
    let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePmId }).first();
    if (saved && saved.customer_id !== invoice.customer_id) {
      logger.warn(`[pay-v2] setup-complete pm ownership mismatch: pm ${stripePmId} belongs to ${saved.customer_id}, invoice customer ${invoice.customer_id}`);
      return res.status(409).json({ error: 'Payment method belongs to another account' });
    }
    // Ownership immediately before the first write, for the same reason as
    // /consent: this route's own check ran before the Stripe round-trip.
    if (await require('../services/visit-completion-packets').invoicePayerOwnedNow(invoice.id)) {
      return res.status(409).json({
        error: 'This invoice is billed to a third-party payer',
        code: 'invoice_withdrawn_from_customer',
      });
    }
    if (!saved) {
      saved = await StripeService.savePaymentMethod(invoice.customer_id, stripePmId, {
        enableAutopay: false,
        // enrollConsentedMethod owns the default decision (claims it only
        // when no healthy method is already in charge).
        makeDefault: false,
      });
    }
    const methodType = (typeof pmObject === 'object' && pmObject?.type) || saved.method_type || 'card';
    const PacketsForConsent = require('../services/visit-completion-packets');
    // A consent row is written only when the method has none yet; the
    // ownership judgement and the enrollment below run either way.
    const needsConsentRow = !(await ConsentService.hasConsentFor(invoice.customer_id, stripePmId));
    // CONSENT *AND* ENROLLMENT UNDER ONE OWNERSHIP JUDGEMENT (local audit on
    // r46, the same pattern /consent uses): committing the authorization
    // first left it recorded when a Bill-To assignment landed before the
    // enrollment and the request answered 409.
    const SETUP_PAYER_BILLED_ROLLBACK = Symbol('setup_payer_billed_rollback');
    let refusedForPayer = false;
    let enrollment = null;
    try {
      await db.transaction(async (trx) => {
        // Customer FOR UPDATE before the SHARE-taking ownership check, so the
        // enrollment's own upgrade cannot deadlock against a sibling request.
        await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');
        if (await PacketsForConsent.invoicePayerOwnedNow(invoice.id, trx)) throw SETUP_PAYER_BILLED_ROLLBACK;
        if (needsConsentRow) {
          await ConsentService.recordConsent({
            customerId: invoice.customer_id,
            paymentMethodId: saved.id,
            stripePaymentMethodId: stripePmId,
            source: 'pay_page',
            methodType,
            ip: req.ip,
            userAgent: req.get('user-agent') || null,
            database: trx,
          });
        }
        const { enrollConsentedMethod } = require('../services/autopay-enrollment');
        enrollment = await enrollConsentedMethod({
          customerId: invoice.customer_id,
          paymentMethodId: saved.id,
          source: 'save_card_consent',
          details: { via: 'covered_by_credit_setup', invoice_id: invoice.id },
          // Invoice visit scope for the in-lock payer check (#3395 r14 P1).
          scheduledServiceId: invoice.scheduled_service_id || null,
          invoiceId: invoice.id,
          dbh: trx,
        });
        if (enrollment?.reason === 'payer_billed') throw SETUP_PAYER_BILLED_ROLLBACK;
      });
    } catch (txErr) {
      if (txErr !== SETUP_PAYER_BILLED_ROLLBACK) throw txErr;
      refusedForPayer = true;
    }
    if (refusedForPayer) {
      return res.status(409).json({
        error: 'This invoice is billed to a third-party payer',
        code: 'invoice_withdrawn_from_customer',
      });
    }
    // Savepoint mode hands the confirmation email back for after the commit.
    if (typeof enrollment?.sendEnrollmentConfirmation === 'function') {
      await enrollment.sendEnrollmentConfirmation();
    }
    // A REFUSED enrollment must leave the invoice collectible (Codex
    // #2507 round-8 P2): settling here would complete the required-save
    // signup prepaid with nothing chargeable enrolled. ach_blocked =
    // the customer's ACH state went unhealthy after /capture-setup
    // minted card_or_bank (or its health lookup failed open) and the
    // customer saved a bank method — the capture state stays
    // re-derivable, and the next /capture-setup mint is card-only while
    // the bank state is unhealthy, so the client restarts capture.
    // already_enrolled is the benign incumbent case.
    if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
      logger.warn(`[pay-v2] setup-complete enrollment refused (${enrollment.reason}) for invoice ${invoice.id} pm ${saved.id} — held coverage NOT settled`);
      // A Bill-To change that beat the enrollment gets the ownership refusal,
      // not the bank-verification copy (Codex #4311 r39 P0).
      if (enrollment.reason === 'payer_billed') {
        return res.status(409).json({
          error: 'This invoice is billed to a third-party payer',
          code: 'invoice_withdrawn_from_customer',
        });
      }
      return res.status(409).json({
        error: 'This bank account can’t power Auto Pay until its verification clears — please use a card instead.',
        enrollReason: enrollment.reason,
      });
    }

    // The capture is done — apply the HELD credit coverage and settle the
    // invoice (Codex #2507 round-7 P1). Idempotent: already-prepaid
    // invoices (pre-hold flow, or the covered_capture webhook won the
    // race) skip as alreadySettled. `settled: false` means the credit no
    // longer fully covers (spent elsewhere mid-capture) — the invoice
    // stays payable and the client re-derives real state instead of
    // showing "covered".
    const settle = await StripeService.settleHeldCoverage(invoice.id);
    res.json({ success: true, settled: settle.settled || settle.alreadySettled });
  } catch (err) {
    logger.error(`[pay-v2] setup-complete failed for invoice ${invoice?.id || 'unknown'}: ${err.message}`);
    res.status(500).json({ error: 'Could not save the payment method' });
  }
});

// =========================================================================
// POST /api/pay/:token/error — Browser-side payment form error report
//
// Used for Stripe.js/network failures that never become a Stripe webhook
// event and may never reach one of the server-side catch blocks above.
// =========================================================================
router.post('/:token/error', clientPaymentErrorLimiter, async (req, res) => {
  try {
    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (shouldSkipClientPaymentErrorAlert(invoice)) {
      return res.json({ success: true, skipped: true, reason: 'non_collectible' });
    }

    const body = req.body || {};
    const message = cleanField(body.message || body.error || 'Payment form error');
    if (!message) return res.json({ success: true, skipped: true });

    const stripeType = cleanField(body.stripeType || '', 100);
    const code = cleanField(body.code || '', 100);

    await BillPaymentErrorAlerts.alertBillPaymentError({
      invoice,
      phase: cleanField(body.phase || 'client', 60),
      methodCategory: cleanField(body.methodCategory || invoice.payment_method || 'unknown', 60),
      paymentIntentId: cleanField(body.paymentIntentId || invoice.stripe_payment_intent_id || '', 128),
      message,
      code,
      statusCode: Number(body.statusCode || 0) || null,
      source: 'client',
      metadata: {
        route: paymentRouteLabel(req),
        stripe_type: stripeType || null,
        client_phase: cleanField(body.clientPhase || '', 100) || null,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`[pay-v2] Client payment error report failed: ${err.message}`);
    res.status(500).json({ error: 'Could not record payment error report' });
  }
});

// =========================================================================
// GET /api/pay/:token/invoice.pdf — Branded invoice PDF for download/print
// =========================================================================
router.get('/:token/invoice.pdf', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    // Phase 2: an accrued invoice's individual PDF is not served — it renders on
    // the consolidated statement (the receipt PDF stays permanent, unaffected).
    if (data.payer_statement_id) return res.status(404).json({ error: 'This charge is billed on the monthly statement.' });
    // Downloaded/printed PDF must show the same Bill-To = payer block as the
    // emailed copy (getByToken doesn't attach the payer on its own).
    await require('../services/payer').attachToInvoice(data);
    // Fail closed: a payer-billed invoice whose payer can't attach (legacy, no
    // snapshot, inactive/deleted) must NOT render the homeowner as Bill-To on
    // the printable PDF. Synthesize a third-party placeholder so the bill-to
    // block stays non-self-pay (mirrors the JSON pay-page fail-closed state).
    if (!data.payer && data.payer_id) {
      data.payer = { company_name: 'Third-party payer', ap_email: null };
    }
    generateInvoicePDF(data, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.invoiceRequiresSavedMethod = invoiceRequiresSavedMethod;
module.exports.invoiceCaptureNeeded = invoiceCaptureNeeded;
module.exports.isZelleTransferEligible = isZelleTransferEligible;
module.exports.payPageZelleVisibility = payPageZelleVisibility;
