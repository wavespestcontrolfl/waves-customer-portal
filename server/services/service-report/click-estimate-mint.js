'use strict';

/**
 * Click-to-estimate mint (GATE_REPORT_CLICK_TO_ESTIMATE) — a PRICED
 * cross-sell tap turns into a real, immediately-viewable estimate at the
 * exact price the card showed, and the tap response redirects into it.
 *
 * Doctrine (all existing mechanisms, composed — never parallel):
 *   - Pricing authority: serverRecomputeFromEstimateData re-runs the engine
 *     from the CARD'S OWN engine context (property input + target service,
 *     captured at option build — customer-pricing-ai includeEngineContext),
 *     with priorQualifyingServices restoring the combined WaveGuard tier.
 *     The recomputed target line must match the shown per-application price
 *     to the cent, or the mint refuses and the card refreshes (the same
 *     drift posture as the offer fingerprint).
 *   - Publish without delivery: the group-sibling publication pattern —
 *     status 'sent' + sent_at + frozen sendSnapshot + all four follow-up
 *     flags pre-burned, so no follow-up/engagement automation can ever
 *     message the customer about an estimate they are already looking at.
 *   - Idempotency: runs inside writeOrRefreshCtaRequest's transaction via
 *     the withRow seam. The request row's pricing_revision.mintedEstimate is
 *     the linkage; a repeat tap on an unchanged offer reuses the live
 *     estimate, a changed offer supersedes (archives) the old one so the
 *     customer never holds two competing honorable prices.
 */

const crypto = require('crypto');
const logger = require('../logger');

// Thrown when the recomputed price no longer matches what the card showed —
// the route maps this to the same 409 refresh the offer-fingerprint drift
// check uses, never a persisted estimate at a price the customer didn't see.
class ClickEstimateDriftError extends Error {
  constructor(message) {
    super(message);
    this.clickEstimateDrift = true;
  }
}

// Statuses under which a previously minted estimate is still the customer's
// live link: publicly viewable and either open or already accepted. Anything
// else (expired, declined, archived, invalidated) means the old link is dead
// and a fresh tap should mint again.
function priorMintStillLive(row, now) {
  if (!row || row.archived_at) return false;
  if (row.status === 'accepted') return true;
  if (!['sent', 'viewed'].includes(String(row.status || ''))) return false;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return false;
  return true;
}

// mintReportClickEstimate(trx, args) → { estimateId, token, url, reused }
// Runs INSIDE the CTA writer's transaction — a throw rolls back the request
// row, the analytics event, and every estimate write together.
async function mintReportClickEstimate(trx, {
  customer,
  service,
  crossSell,
  requestRow,
  priorPricingRevision,
  deduped,
  revisionSnapshot,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  deps = {},
}) {
  const {
    estimateViewUrl,
    estimateExpiresAt,
    serverRecomputeFromEstimateData,
  } = deps.persistence || require('../admin-estimate-persistence');
  const recompute = deps.recompute || serverRecomputeFromEstimateData;
  const { quotedPerVisitForServiceKey, addressForCustomer } = deps.pricingAi || require('../customer-pricing-ai');
  const computeMembershipContext = deps.computeMembershipContext
    || require('../estimate-membership-context').computeMembershipContext;
  const { pricingBundleMatchesEstimateTotals } = deps.bundleUtils
    || require('../estimate-pricing-bundle-utils');
  // Route adapter, lazy to avoid a service→route load-order cycle (same
  // pattern as serverRecomputeFromEstimateData's translate require).
  const buildEstimateSendSnapshot = deps.buildEstimateSendSnapshot
    || require('../../routes/admin-estimates').buildEstimateSendSnapshot;

  const nowDate = now();

  // ── Reuse: identical offer, estimate already minted and still live ──────
  const prior = priorPricingRevision?.mintedEstimate || null;
  let priorRow = null;
  if (prior?.id) {
    priorRow = await trx('estimates').where({ id: prior.id }).forUpdate().first();
  }
  if (deduped && priorMintStillLive(priorRow, nowDate)) {
    return {
      estimateId: priorRow.id,
      token: priorRow.token,
      url: estimateViewUrl(priorRow.token),
      reused: true,
    };
  }

  // ── Mint ────────────────────────────────────────────────────────────────
  const context = crossSell?.engineContext;
  const option = crossSell?.option;
  if (!context?.propertyInput || !context?.targetOnlyServices || !option?.perVisit) {
    throw new Error('click-to-estimate mint called without engine context');
  }
  const priorQualifyingServices = Array.isArray(context.currentServiceKeys)
    ? context.currentServiceKeys.filter(Boolean)
    : [];

  // The persisted replay input: the card's exact property facts + the target
  // service ALONE. Identity (priorQualifyingServices / recurringCustomer) is
  // deliberately NOT baked in — serverRecomputeFromEstimateData strips
  // client-claimable identity and re-applies it from the server-derived deps,
  // and the public page re-injects estimate_data.priorQualifyingServices on
  // every replay (extractEngineInputs), so display and accept keep pricing at
  // the combined tier without a forgeable input field.
  const estimateData = {
    engineInputs: {
      ...context.propertyInput,
      services: context.targetOnlyServices,
    },
    ...(priorQualifyingServices.length ? { priorQualifyingServices } : {}),
    reportCtaMint: {
      serviceRecordId: service.id,
      requestId: requestRow.id,
      fingerprint: crossSell.fingerprint || null,
      shownPerApplication: option.perVisit,
      mintedAt: nowDate.toISOString(),
      ...(priorRow ? { supersededEstimateId: priorRow.id } : {}),
    },
  };

  const recomputed = await recompute(estimateData, {
    priorQualifyingServices,
    recurringCustomer: priorQualifyingServices.length > 0,
  });
  if (!recomputed?.recomputed) {
    throw new Error(`click-to-estimate recompute failed (${recomputed?.reason || 'unknown'})`);
  }

  // Cent-exact price-lock check, via the SAME derivation the card's quote
  // used (quotedPerVisitForServiceKey wraps the composer's own line/amount
  // functions). The card priced the target inside a combined run; this
  // estimate prices it target-only with the tier restored through
  // priorQualifyingServices — equality here is what proves those two frames
  // agree, and any disagreement refuses the mint instead of publishing a
  // price the customer never saw.
  const serverPerVisit = quotedPerVisitForServiceKey(recomputed.rawEngineResult, crossSell.serviceKey);
  if (!(Number.isFinite(serverPerVisit) && Math.abs(serverPerVisit - option.perVisit) < 0.005)) {
    throw new ClickEstimateDriftError(
      `minted per-application price would not match the card (card=${option.perVisit} server=${serverPerVisit})`,
    );
  }
  const serverTier = recomputed.rawEngineResult?.waveGuard?.tier
    || recomputed.rawEngineResult?.waveGuard?.label || null;
  if (option.waveguardTier && serverTier && option.waveguardTier !== serverTier) {
    throw new ClickEstimateDriftError(
      `minted WaveGuard tier would not match the card (card=${option.waveguardTier} server=${serverTier})`,
    );
  }

  // Store the server-computed result + stamp the priced pest curve, exactly
  // as resolveServerAuthoritativePricing does for builder saves.
  estimateData.result = recomputed.serverResult;
  if (recomputed.pestPricingVersion && estimateData.engineInputs.services?.pest
    && typeof estimateData.engineInputs.services.pest === 'object') {
    estimateData.engineInputs.services.pest.version = recomputed.pestPricingVersion;
  }

  // Existing-member treatment (IB agent-estimate posture): a recognized
  // customer's estimate must carry the membership snapshot or the page shows
  // new-customer terms. FAIL CLOSED for members — a transient membership
  // read failure rolls the whole tap back to a retryable 503 rather than
  // minting an estimate with the wrong terms.
  let membershipSnapshot = null;
  try {
    membershipSnapshot = await computeMembershipContext(trx, {
      customerId: customer.id,
      estData: {
        lineItems: recomputed.rawEngineResult?.lineItems || [],
        recurring: {
          annualBeforeDiscount: Number(recomputed.rawEngineResult?.summary?.recurringAnnualBeforeDiscount || 0),
          annualAfterDiscount: Number(recomputed.rawEngineResult?.summary?.recurringAnnualAfterDiscount || 0),
        },
      },
    });
  } catch (err) {
    membershipSnapshot = null;
    logger.warn(`[click-estimate-mint] membership context failed (code=${err?.code || 'none'})`);
  }
  if (!membershipSnapshot && priorQualifyingServices.length) {
    throw new Error('existing-member context could not be loaded for click-to-estimate mint');
  }
  if (membershipSnapshot) estimateData.membershipSnapshot = membershipSnapshot;

  const totals = recomputed.serverTotals || {};
  const monthlyTotal = Number(totals.monthlyTotal || 0);
  const annualTotal = Number(totals.annualTotal || 0) || monthlyTotal * 12;
  const onetimeTotal = Number(totals.onetimeTotal || 0);

  const token = randomBytes(16).toString('hex');
  const expiresAt = estimateExpiresAt(now);
  const [created] = await trx('estimates').insert({
    estimate_data: JSON.stringify(estimateData),
    // The same address string the pricing lookup was keyed on — the offer is
    // anchored to the customer's PRIMARY property (proven upstream by the
    // card's locality frames), and estimate linkage parsers read this column.
    address: addressForCustomer(customer) || null,
    customer_id: customer.id,
    customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null,
    customer_phone: customer.phone || null,
    customer_email: customer.email || null,
    monthly_total: monthlyTotal,
    annual_total: annualTotal,
    onetime_total: onetimeTotal,
    waveguard_tier: serverTier,
    token,
    expires_at: expiresAt,
    notes: null,
    // Publish-without-delivery (group-sibling pattern): viewable + acceptable
    // immediately, with every follow-up flag pre-burned so no reminder or
    // engagement automation ever messages the customer about it.
    status: 'sent',
    sent_at: nowDate,
    followup_unviewed_sent: true,
    followup_viewed_sent: true,
    followup_final_sent: true,
    followup_expiring_sent: true,
    source: 'service_report_cta',
    service_interest: crossSell.label || null,
    category: 'RESIDENTIAL',
    pricing_authority: 'SERVER',
    server_computed_price: annualTotal > 0 ? annualTotal : null,
  }).returning('*');

  // Freeze the send snapshot — the same builder the send/sibling paths use,
  // so the shown price replays from the snapshot instead of live config. A
  // snapshot that failed to freeze is a publication failure, not a warning
  // (sibling-publication rule): without it the public page silently
  // re-prices live and the lock is a lie.
  const withSnapshot = await buildEstimateSendSnapshot(created, now);
  if (!withSnapshot?.sendSnapshot || withSnapshot.sendSnapshot.pricingBundleError) {
    throw new Error(`click-to-estimate send snapshot did not freeze pricing${withSnapshot?.sendSnapshot?.pricingBundleError ? `: ${withSnapshot.sendSnapshot.pricingBundleError}` : ''}`);
  }
  if (!pricingBundleMatchesEstimateTotals(withSnapshot.sendSnapshot.pricingBundle, created)) {
    throw new Error('click-to-estimate send snapshot does not match the minted totals');
  }
  await trx('estimates').where({ id: created.id }).update({
    estimate_data: JSON.stringify(withSnapshot),
    updated_at: nowDate,
  });

  // Supersede a prior mint the customer may still hold: two live links at
  // two honorable prices for one offer is the exact ambiguity the
  // price-lock ruling exists to prevent. Accepted/locked rows are never
  // touched (acceptance already spun up downstream records).
  if (priorRow && !priorRow.archived_at && priorRow.status !== 'accepted' && !priorRow.price_locked_at) {
    await trx('estimates')
      .where({ id: priorRow.id })
      .whereNull('archived_at')
      .whereNull('price_locked_at')
      .whereNot({ status: 'accepted' })
      .update({ archived_at: nowDate, updated_at: nowDate });
  }

  // Stamp the linkage on the request row. mintedEstimate is excluded from
  // the writer's dedupe compare, so this stamp cannot turn the next
  // identical tap into a refresh.
  await trx('service_requests').where({ id: requestRow.id }).update({
    pricing_revision: JSON.stringify({ ...revisionSnapshot, mintedEstimate: { id: created.id, token, mintedAt: nowDate.toISOString() } }),
    updated_at: nowDate,
  });

  return { estimateId: created.id, token, url: estimateViewUrl(token), reused: false };
}

module.exports = { mintReportClickEstimate, ClickEstimateDriftError, priorMintStillLive };
