'use strict';

// ============================================================
// termite-annual-signature-charge.js — collects the termite annual plan's
// setup + first annual fee when the customer signs (owner ruling
// 2026-09-25 on #4819): charge the saved (Auto Pay-enrolled) payment method
// on file; with no enrolled method, fall back to the pay link exactly as
// before. Owner countersignature is a separate record step and never gates
// this.
//
// Called by termite-annual-activation.js AFTER the activation transaction
// has committed the annual_prepay invoice + term — never inside it, and no
// DB lock is held across the Stripe call. The caller delivers the pay link
// when this returns deliverPayLink: true.
//
// At most ONE automatic charge per activated estimate/invoice: a
// compare-and-swap from NULL on estimates.annual_plan_signature_charge
// claims the attempt before anything else runs, and every later entry
// (the sign hook, the daily reconciliation sweep, a replay) reads the
// recorded outcome instead of charging again:
//   paid / processing   → nothing to send; the charge service's own receipt
//                         is the customer's confirmation
//   declined / skipped  → pay link (a decline also rang the owner bell)
//   ambiguous / claimed → owner bell, NO pay link — money may be moving;
//                         staff reconcile. Never retried automatically.
// A decline is never retried automatically either (ruling A-13).
//
// Reuses the accept route's saved-method machinery rather than a second
// implementation: RecurringCards.resolvePrepayChargeMethod picks the
// enrolled method, the consent ledger (payment-method-consents) records the
// authorization, StripeService.chargeInvoiceWithSavedCard owns the
// surcharge / credit / durable Stripe attempt fence / receipt, and the
// shared RecurringCards classifiers read the outcome the same way the
// accept route does.
//
// Authorization: the customer's signature on the annual agreement. It is
// recorded in the consent ledger with the SIGNED agreement text as the
// snapshot and evidence_contract_id pointing at the signed contract. The
// charge is capped at the total frozen when the customer accepted
// (maxAuthorizedTotalCents) — the agreement's prices are total maximum
// prices, so a card whose surcharge would push past that total is skipped
// (the charge service's own quote, checked first) and gets the pay link.
// ============================================================

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const PAY_LINK_OUTCOMES = new Set(['declined', 'skipped']);
const SETTLED_OUTCOMES = new Set(['paid', 'processing']);

function parseJsonish(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

const BELL_COPY = {
  charge_declined: (ctx) => ({
    title: 'Termite annual plan — card on file declined at signing',
    body: `The customer signed the annual termite agreement (estimate #${ctx.estimateId}) and the plan is active, but charging the payment method on file for invoice #${ctx.invoiceId} failed: ${ctx.reason}. The pay link is being sent instead. The card will NOT be retried automatically.`,
  }),
  charge_unresolved: (ctx) => ({
    title: 'Termite annual plan — signing charge needs reconciliation',
    body: `The charge for invoice #${ctx.invoiceId} (estimate #${ctx.estimateId}) may or may not have gone through (${ctx.reason}). No pay link was sent. Check Stripe and the invoice before collecting any other way.`,
  }),
  charge_deferred: (ctx) => ({
    title: 'Termite annual plan — signing charge not attempted',
    body: `Invoice #${ctx.invoiceId} (estimate #${ctx.estimateId}) was not charged and no pay link was sent: ${ctx.reason}. Resolve it and collect from the invoice.`,
  }),
  surcharge_not_authorized: (ctx) => ({
    title: 'Termite annual plan — card on file not charged (surcharge)',
    body: `The payment method on file for invoice #${ctx.invoiceId} (estimate #${ctx.estimateId}) is a credit card whose surcharge would exceed the total the customer signed for, so it was not charged. The pay link is being sent instead; the customer sees the exact total before paying.`,
  }),
  no_accepted_amount: (ctx) => ({
    title: 'Termite annual plan — no accepted total to charge against',
    body: `Invoice #${ctx.invoiceId} (estimate #${ctx.estimateId}) has no valid accepted-price snapshot, so the card on file was not charged. The pay link is being sent instead.`,
  }),
};

async function ringBell(kind, ctx) {
  try {
    const { title, body } = BELL_COPY[kind](ctx);
    await require('./notification-service').notifyAdmin('billing', title, body, {
      icon: '⚠️',
      link: `/admin/estimates?estimateId=${ctx.estimateId}`,
      bell: true,
      dedupeKey: `termite-annual-signature-charge:${ctx.estimateId}:${kind}`,
      metadata: { estimateId: ctx.estimateId, invoiceId: ctx.invoiceId, reason: ctx.reason },
    });
  } catch (err) {
    logger.error(`[termite-annual-charge] bell failed for estimate ${ctx.estimateId}: ${err.message}`);
  }
}

async function readChargeState(conn, estimateId) {
  const row = await conn('estimates').where({ id: estimateId }).first('annual_plan_signature_charge');
  return parseJsonish(row?.annual_plan_signature_charge);
}

// Resolve our own claim — only while our token still holds it.
async function resolveClaim(conn, estimateId, claimToken, outcome) {
  try {
    await conn('estimates')
      .where({ id: estimateId })
      .whereRaw("annual_plan_signature_charge ->> 'claim_token' = ?", [claimToken])
      .update({
        annual_plan_signature_charge: conn.raw('annual_plan_signature_charge || ?::jsonb', [
          JSON.stringify({ ...outcome, resolved_at: new Date().toISOString() }),
        ]),
      });
  } catch (err) {
    logger.error(`[termite-annual-charge] outcome stamp failed for estimate ${estimateId}: ${err.message}`);
  }
}

// Release a claim for an attempt that provably never reached Stripe, so
// the reconciliation sweep can try again.
async function releaseClaim(conn, estimateId, claimToken) {
  try {
    await conn('estimates')
      .where({ id: estimateId })
      .whereRaw("annual_plan_signature_charge ->> 'claim_token' = ?", [claimToken])
      .update({ annual_plan_signature_charge: null });
  } catch (err) {
    logger.error(`[termite-annual-charge] claim release failed for estimate ${estimateId}: ${err.message}`);
  }
}

// What a later entry does with an attempt someone else already claimed.
// A claim younger than this may still be mid-charge in another process.
const IN_FLIGHT_CLAIM_MS = 60 * 60 * 1000;

async function followExistingOutcome(existing, ctx) {
  const status = existing?.status || 'claimed';
  if (PAY_LINK_OUTCOMES.has(status)) return { status, reason: existing.reason || null, deliverPayLink: true };
  if (SETTLED_OUTCOMES.has(status)) return { status, reason: existing.reason || null, deliverPayLink: false };
  if (status === 'deferred') {
    await ringBell('charge_deferred', { ...ctx, reason: existing.reason || 'held for staff' });
    return { status, reason: existing.reason || null, deliverPayLink: false };
  }
  const claimedAt = existing?.claimed_at ? new Date(existing.claimed_at).getTime() : 0;
  if (status === 'claimed' && Date.now() - claimedAt < IN_FLIGHT_CLAIM_MS) {
    return { status: 'in_flight', reason: 'claimed_elsewhere', deliverPayLink: false };
  }
  await ringBell('charge_unresolved', { ...ctx, reason: existing?.reason || 'the charge attempt never recorded an outcome' });
  return { status: 'ambiguous', reason: existing?.reason || 'unresolved_claim', deliverPayLink: false };
}

async function signedAnnualContractFor(conn, estimateId, contractId) {
  const q = conn('customer_contracts')
    .where({ document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed' });
  if (contractId) q.where({ id: contractId });
  else q.whereRaw("document_variables_snapshot -> 'estimate' ->> 'id' = ?", [String(estimateId)]).orderBy('signed_at', 'desc');
  return q.first('id', 'contract_text_snapshot', 'annual_plan_version', 'signed_at', 'signer_ip', 'signer_user_agent');
}

// The agreement signature IS the authorization — record it in the consent
// ledger once per (contract, method). Throws on failure (caller defers).
async function recordSignatureConsent({ conn, customerId, method, contract }) {
  const existing = await conn('payment_method_consents')
    .where({
      customer_id: customerId,
      stripe_payment_method_id: method.stripePaymentMethodId,
      evidence_contract_id: contract.id,
    })
    .first('id');
  if (existing) return;
  await require('./payment-method-consents').recordConsent({
    customerId,
    paymentMethodId: method.paymentMethodRowId,
    stripePaymentMethodId: method.stripePaymentMethodId,
    source: 'contract_signing',
    methodType: method.methodType || 'card',
    ip: contract.signer_ip || null,
    userAgent: contract.signer_user_agent || null,
    consentTextSnapshot: contract.contract_text_snapshot,
    consentTextVersion: `termite_annual_agreement_${contract.annual_plan_version || 'v3'}`,
    evidenceContractId: contract.id,
  });
}

function classifyChargeError(err) {
  const RecurringCards = require('./recurring-card-on-file');
  if (RecurringCards.isAmbiguousSavedMethodChargeError(err)) return { status: 'ambiguous', reason: err.code || err.message };
  // A payer assigned after the mint: the homeowner's card must not pay it,
  // and neither may the homeowner's pay link — staff route it.
  if (err?.code === 'PAYER_BILLED_GUARD') return { status: 'deferred', reason: 'payer_billed_guard' };
  // A 3DS step-up leaves the off-session intent alive in requires_action —
  // a pay link beside it would be a second collection rail.
  if (err?.wavesCardDecline?.declineCode === 'authentication_required') return { status: 'ambiguous', reason: 'authentication_required' };
  return { status: 'declined', reason: err?.message || 'charge failed' };
}

function classifyVerifiedCharge(freshInvoice, chargeResult) {
  const outcome = require('./recurring-card-on-file').classifySavedMethodChargeInvoice(freshInvoice);
  if (outcome === 'paid') {
    const coveredByCredit = chargeResult?.covered_by_credit === true || String(freshInvoice?.status) === 'prepaid';
    return { status: 'paid', ...(coveredByCredit ? { covered_by_credit: true } : {}) };
  }
  if (outcome === 'bank_processing') return { status: 'processing' };
  if (outcome === 'card_incomplete') return { status: 'ambiguous', reason: 'card_intent_incomplete' };
  return { status: 'declined', reason: `post-charge status ${freshInvoice?.status || 'unknown'}` };
}

// Everything between a won claim and the Stripe call. Returns an outcome to
// record, or { release: true } when nothing was attempted and the claim
// should be handed back for a later retry.
async function runClaimedCharge({ conn, ctx, trigger }) {
  const RecurringCards = require('./recurring-card-on-file');
  if (!RecurringCards.isPrepayCardAndChargeEnabled()) return { status: 'skipped', reason: 'gate_off' };

  const invoice = await conn('invoices').where({ id: ctx.invoiceId }).first('id', 'customer_id', 'payer_id', 'status');
  if (!invoice) return { status: 'skipped', reason: 'invoice_missing' };
  if (invoice.payer_id) return { status: 'skipped', reason: 'payer_billed' };

  let frozenTotalCents;
  try {
    const estimate = await conn('estimates').where({ id: ctx.estimateId }).first('id', 'annual_plan_deferred_invoice');
    frozenTotalCents = Math.round(require('./estimate-converter').frozenTermiteAnnualFinancialsFor(estimate).total * 100);
  } catch {
    await ringBell('no_accepted_amount', ctx);
    return { status: 'skipped', reason: 'no_accepted_amount' };
  }

  const method = await RecurringCards.resolvePrepayChargeMethod({
    policy: { exemptReason: 'autopay_already_active' },
    customerId: invoice.customer_id,
  });
  if (!method?.paymentMethodRowId) return { status: 'skipped', reason: 'no_enrolled_method' };

  // The agreement's prices are total maximums: a credit-card surcharge
  // that would carry the charge past the accepted total is not authorized
  // by the signature, so that customer gets the pay link (which shows the
  // exact surcharge before paying). Checked up front with the charge
  // service's own quote so it is a clear skip, not a decline; if the quote
  // itself fails, the charge's maxAuthorizedTotalCents ceiling still holds.
  const StripeService = require('./stripe');
  try {
    const quote = await StripeService.quoteInvoiceSavedCardCharge(ctx.invoiceId, method.paymentMethodRowId);
    if (Math.round(Number(quote?.total) * 100) > frozenTotalCents) {
      await ringBell('surcharge_not_authorized', ctx);
      return { status: 'skipped', reason: 'surcharge_exceeds_accepted_total' };
    }
  } catch (err) {
    logger.warn(`[termite-annual-charge] pre-charge quote failed for invoice ${ctx.invoiceId} — relying on the charge ceiling: ${err.message}`);
  }

  try {
    const contract = await signedAnnualContractFor(conn, ctx.estimateId, ctx.contractId);
    if (!contract?.contract_text_snapshot) throw new Error('signed annual agreement not found');
    await recordSignatureConsent({
      conn, customerId: invoice.customer_id, method, contract,
    });
  } catch (err) {
    logger.warn(`[termite-annual-charge] consent record failed for estimate ${ctx.estimateId} — releasing for retry: ${err.message}`);
    await ringBell('charge_deferred', { ...ctx, reason: 'the signing authorization could not be recorded yet; the daily sweep will retry' });
    return { release: true };
  }

  let chargeResult;
  try {
    chargeResult = await StripeService.chargeInvoiceWithSavedCard(ctx.invoiceId, method.paymentMethodRowId, {
      // The sign hook answers the customer's own signature (any-hour
      // receipt); the daily sweep is machine-initiated.
      customerInitiated: trigger === 'signature',
      maxAuthorizedChargeCents: frozenTotalCents,
      maxAuthorizedTotalCents: frozenTotalCents,
      // Serialize against an Auto Pay pause/opt-out committing mid-charge.
      requireAutopayForCustomerId: invoice.customer_id,
      requireSelfPayCustomerId: invoice.customer_id,
    });
  } catch (err) {
    return classifyChargeError(err);
  }
  // The charge committed once the call returned — a failed re-read is
  // ambiguous, never a decline.
  try {
    const fresh = await conn('invoices').where({ id: ctx.invoiceId }).first('status', 'payment_method');
    return classifyVerifiedCharge(fresh, chargeResult);
  } catch (err) {
    logger.error(`[termite-annual-charge] post-charge invoice read failed for ${ctx.invoiceId}: ${err.message}`);
    return { status: 'ambiguous', reason: 'post_charge_status_unverified' };
  }
}

/**
 * Attempt the at-most-once signature charge for an activated termite annual
 * plan invoice. Never throws.
 *
 * @returns {Promise<{status: string, reason: string|null, deliverPayLink: boolean}>}
 */
async function chargeAnnualInvoiceAtSignature({
  estimateId, contractId = null, invoiceId, conn = db, trigger = 'sweep',
}) {
  const ctx = { estimateId, contractId, invoiceId };
  const claimToken = crypto.randomUUID();
  let claimed = 0;
  try {
    claimed = await conn('estimates')
      .where({ id: estimateId })
      .whereNull('annual_plan_signature_charge')
      .update({
        annual_plan_signature_charge: JSON.stringify({
          status: 'claimed', claim_token: claimToken, invoice_id: invoiceId, trigger, claimed_at: new Date().toISOString(),
        }),
      });
  } catch (err) {
    // Nothing was charged — but a pay link now could sit beside a charge a
    // later sweep makes, so send neither; the sweep retries the claim.
    logger.error(`[termite-annual-charge] claim failed for estimate ${estimateId}: ${err.message}`);
    return { status: 'deferred', reason: 'claim_failed', deliverPayLink: false };
  }

  try {
    if (claimed !== 1) return await followExistingOutcome(await readChargeState(conn, estimateId), ctx);

    const outcome = await runClaimedCharge({ conn, ctx, trigger });
    if (outcome.release) {
      await releaseClaim(conn, estimateId, claimToken);
      return { status: 'deferred', reason: 'consent_record_failed', deliverPayLink: false };
    }
    await resolveClaim(conn, estimateId, claimToken, outcome);
    if (outcome.status === 'declined') await ringBell('charge_declined', { ...ctx, reason: outcome.reason });
    if (outcome.status === 'ambiguous') await ringBell('charge_unresolved', { ...ctx, reason: outcome.reason });
    if (outcome.status === 'deferred') await ringBell('charge_deferred', { ...ctx, reason: outcome.reason });
    logger.info(`[termite-annual-charge] estimate ${estimateId} invoice ${invoiceId}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    return { status: outcome.status, reason: outcome.reason || null, deliverPayLink: PAY_LINK_OUTCOMES.has(outcome.status) };
  } catch (err) {
    // Unexpected: our claim stands unresolved, so it is treated as
    // ambiguous from here on — never retried, never a pay link.
    logger.error(`[termite-annual-charge] unexpected failure for estimate ${estimateId}: ${err.message}`);
    await ringBell('charge_unresolved', { ...ctx, reason: err.message });
    return { status: 'ambiguous', reason: err.message, deliverPayLink: false };
  }
}

module.exports = {
  chargeAnnualInvoiceAtSignature,
  _private: { classifyChargeError, classifyVerifiedCharge },
};
