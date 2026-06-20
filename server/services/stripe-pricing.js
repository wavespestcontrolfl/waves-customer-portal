/**
 * Stripe surcharge helpers — pure, dependency-free, test-friendly.
 *
 * Phase 1: flat 2.9% surcharge on confirmed-credit-only. Debit, prepaid,
 * unknown-funding, and ACH pay the quoted amount with no surcharge.
 *
 * Uses Stripe's surcharge API (`amount_details.surcharge`) with
 * `enforce_validation: 'enabled'`. Surcharge PI calls require
 * `apiVersion: '2026-03-25.preview'` passed per-request.
 *
 * If you change CONFIGURED_COST_BPS you MUST also bump the consent
 * version (server/services/payment-method-consent-text.js) and the
 * SURCHARGE_POLICY_VERSION below.
 */

// ── Rate policy ──────────────────────────────────────────────
// CONFIGURED_COST_BPS must be ≤ actual merchant discount rate (card-brand
// rules cap the surcharge at the merchant's true cost of acceptance, not the
// network ceiling). Stripe's cost is 2.9% + $0.30, so the effective per-txn
// rate is always ≥ 2.9%; a flat 2.9% stays at/under cost on every ticket size,
// while 3% would exceed cost on larger tickets where the fixed fee is dilutive.
// The fixed $0.30 component cannot be surcharged, so we only pass the % part.
// Confirm with finance/legal before launch.
const CONFIGURED_COST_BPS = 290;     // 2.90%
const NETWORK_CAP_BPS = 300;         // Visa US credit card ceiling (secondary cap)
const SURCHARGE_POLICY_VERSION = 'v2_2026-06-17';
const SURCHARGE_API_VERSION = '2026-03-25.preview';

// ── Legacy exports (deprecated — use cents/bps API) ─────────
// Kept so callers that import CARD_SURCHARGE_RATE keep compiling
// during the transition. Remove after all callers migrate.
const CARD_SURCHARGE_RATE = CONFIGURED_COST_BPS / 10_000;  // 0.029

// ── ACH / bank detection ─────────────────────────────────────
function isCardMethodType(methodType) {
  if (!methodType) return false;
  const m = String(methodType).toLowerCase();
  if (m === 'ach' || m === 'us_bank_account' || m === 'bank' || m === 'bank_account') return false;
  return true;
}

// ── Surcharge eligibility ────────────────────────────────────
// Only surcharge when funding is positively confirmed as 'credit'.
// null / unknown / debit / prepaid → no surcharge.
function shouldSurcharge(methodType, funding) {
  if (!isCardMethodType(methodType)) return false;
  return funding === 'credit';
}

// ── Cents math ───────────────────────────────────────────────
// Math.floor ensures we never exceed the configured cap by a cent.
function computeSurchargeCents(baseCents, opts = {}) {
  const { costBps = CONFIGURED_COST_BPS, capBps = NETWORK_CAP_BPS, stripeMaxCents } = opts;
  const byCost = Math.floor((baseCents * costBps) / 10_000);
  const byCap = Math.floor((baseCents * capBps) / 10_000);
  let result = Math.min(byCost, byCap);
  if (stripeMaxCents != null) result = Math.min(result, stripeMaxCents);
  return result;
}

// ── Primary charge-amount calculator ─────────────────────────
// Returns cents + basis-point facts for storage on the payment record.
function computeChargeAmount(baseAmountDollars, methodType, opts = {}) {
  const { funding, stripeMaxCents } = opts;
  const baseCents = Math.round(Number(baseAmountDollars) * 100);
  if (!shouldSurcharge(methodType, funding)) {
    return {
      baseCents,
      surchargeCents: 0,
      totalCents: baseCents,
      rateBps: 0,
      policyVersion: SURCHARGE_POLICY_VERSION,
      // Legacy dollar shape (deprecated)
      base: baseCents / 100,
      surcharge: 0,
      total: baseCents / 100,
      rate: 0,
    };
  }
  const surchargeCents = computeSurchargeCents(baseCents, { stripeMaxCents });
  const totalCents = baseCents + surchargeCents;
  return {
    baseCents,
    surchargeCents,
    totalCents,
    rateBps: CONFIGURED_COST_BPS,
    policyVersion: SURCHARGE_POLICY_VERSION,
    // Legacy dollar shape (deprecated)
    base: baseCents / 100,
    surcharge: Math.round(surchargeCents) / 100,
    total: totalCents / 100,
    rate: CONFIGURED_COST_BPS / 10_000,
  };
}

// ── Stripe amount_details builder ────────────────────────────
// Returns the amount_details object to pass to PI create/update/confirm/capture.
// Returns null when no surcharge applies (caller should omit the field).
function buildSurchargeAmountDetails(surchargeCents, opts = {}) {
  if (!surchargeCents || surchargeCents <= 0) return null;
  // Online card-on-file uses Stripe-side 'enabled' validation. The card-present
  // flow passes 'disabled' (probe-proven on the live account for card_present):
  // funding is only known post-tap and we already self-enforce credit-only +
  // the cost-of-acceptance cap via planCardPresentSurcharge/computeSurchargeCents.
  const { enforceValidation = 'enabled' } = opts;
  return {
    surcharge: {
      amount: surchargeCents,
      enforce_validation: enforceValidation,
    },
  };
}

// ── Card-present (Tap to Pay) surcharge planner ──────────────
// Pure decision for the in-person two-step flow: the card_present PI is minted
// at base BEFORE the card is read (funding unknown), then this plan decides what
// to do once the tap reveals funding, just before the device confirms.
//
//   alreadyFinalized — the PI already carries surcharge metadata from a prior
//     /apply-surcharge call (idempotent re-invocation). Re-applying would double
//     the amount, so we hold and report the existing state.
//
// Actions:
//   'already'        — finalized on a prior call; do not touch the PI again.
//   'apply_surcharge'— credit card: raise PI amount to total + amount_details.
//   'finalize_base'  — debit/prepaid/unknown: stamp metadata, amount unchanged.
//
// Card-present funding ('debit'/'credit'/'prepaid'/'unknown') flows through the
// SAME shouldSurcharge gate as online — only positively-confirmed credit is
// surcharged; everything else (incl. unknown) collects base, fail-safe.
function planCardPresentSurcharge({ baseCents, funding, alreadyFinalized = false }) {
  const policyVersion = SURCHARGE_POLICY_VERSION;
  if (alreadyFinalized) {
    return { action: 'already', baseCents, surchargeCents: 0, totalCents: baseCents, rateBps: 0, policyVersion, funding: funding || null };
  }
  const surchargeCents = shouldSurcharge('card_present', funding)
    ? computeSurchargeCents(baseCents)
    : 0;
  return {
    action: surchargeCents > 0 ? 'apply_surcharge' : 'finalize_base',
    baseCents,
    surchargeCents,
    totalCents: baseCents + surchargeCents,
    rateBps: surchargeCents > 0 ? CONFIGURED_COST_BPS : 0,
    policyVersion,
    funding: funding || null,
  };
}

// ── Refund surcharge proration ───────────────────────────────
// Cumulative tracking: avoids penny drift across multiple partial refunds.
function computeRefundSurcharge({
  refundBaseCents,
  originalBaseCents,
  originalSurchargeCents,
  totalRefundedBaseCents = 0,
  alreadyRefundedSurchargeCents = 0,
}) {
  if (originalSurchargeCents <= 0 || originalBaseCents <= 0) return 0;
  const remainingSurcharge = originalSurchargeCents - alreadyRefundedSurchargeCents;
  if (remainingSurcharge <= 0) return 0;

  // Full refund of remaining base → return all remaining surcharge
  const cumulativeRefundedBase = totalRefundedBaseCents + refundBaseCents;
  if (cumulativeRefundedBase >= originalBaseCents) return remainingSurcharge;

  // Partial: prorate cumulatively, then subtract already refunded
  const targetRefundedSurcharge = Math.round(
    (cumulativeRefundedBase * originalSurchargeCents) / originalBaseCents,
  );
  return Math.min(
    Math.max(0, targetRefundedSurcharge - alreadyRefundedSurchargeCents),
    remainingSurcharge,
  );
}

module.exports = {
  // Phase 1 constants
  CONFIGURED_COST_BPS,
  NETWORK_CAP_BPS,
  SURCHARGE_POLICY_VERSION,
  SURCHARGE_API_VERSION,

  // Core functions
  isCardMethodType,
  shouldSurcharge,
  computeSurchargeCents,
  computeChargeAmount,
  buildSurchargeAmountDetails,
  planCardPresentSurcharge,
  computeRefundSurcharge,

  // Legacy (deprecated — use cents/bps API)
  CARD_SURCHARGE_RATE,
};
