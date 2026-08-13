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
// RELATIVE estimate path (uncapped audit r4 P1): the report and estimate
// pages are one SPA, and the tapping browser is already ON the right origin
// — prod, preview, or dev. An absolute prod URL (estimateViewUrl) fails the
// client's same-origin guard everywhere except prod, silently recording the
// request but never opening the estimate. The client resolves this against
// its own origin; nothing durable stores it (the request-row linkage keeps
// only id/token).
function estimatePathFor(token) {
  return `/estimate/${token}`;
}

// Lock every prior CTA-mint estimate row for this customer + service —
// NOWAIT, because this transaction already holds the CTA writer's
// customer-row lock. Both lock orders exist in the repo (acceptance:
// estimates → customer via EstimateConverter; admin customer edits:
// customer → estimates), so no ordering can avoid every cycle (in-hook
// audits r5+r6). What removes the deadlock is never WAITING on an
// estimate lock while holding the customer lock: a held lineage row means
// the customer is concurrently accepting (or staff is editing) that very
// estimate — PG answers 55P03 immediately, the transaction rolls back
// whole, and the route's non-drift mint-failure path returns the
// retryable 503 the card already handles. No cycle can include this edge.
async function lockPriorMintLineage(trx, { customerId, serviceKey }) {
  return trx('estimates')
    .where({ customer_id: customerId, source: 'service_report_cta' })
    .whereNull('archived_at')
    .whereRaw("estimate_data->'reportCtaMint'->>'serviceKey' = ?", [String(serviceKey || '')])
    .forUpdate()
    .noWait();
}

// Parse a stored estimates row's mint marker (jsonb hydrates as object,
// legacy text columns as string).
function reportCtaMintOf(row) {
  try {
    const data = typeof row.estimate_data === 'string'
      ? JSON.parse(row.estimate_data)
      : row.estimate_data;
    return data?.reportCtaMint || null;
  } catch {
    return null;
  }
}

async function mintReportClickEstimate(trx, {
  customer,
  service,
  crossSell,
  requestRow,
  deduped,
  revisionSnapshot,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  deps = {},
}) {
  const {
    estimateExpiresAt,
    serverRecomputeFromEstimateData,
  } = deps.persistence || require('../admin-estimate-persistence');
  const recompute = deps.recompute || serverRecomputeFromEstimateData;
  const {
    quotedPerVisitForServiceKey, addressForCustomer, loadCurrentServiceKeys, loadTurfProfile,
  } = deps.pricingAi || require('../customer-pricing-ai');
  const computeMembershipContext = deps.computeMembershipContext
    || require('../estimate-membership-context').computeMembershipContext;
  const { pricingBundleMatchesEstimateTotals } = deps.bundleUtils
    || require('../estimate-pricing-bundle-utils');
  // Route adapter, lazy to avoid a service→route load-order cycle (same
  // pattern as serverRecomputeFromEstimateData's translate require).
  const buildEstimateSendSnapshot = deps.buildEstimateSendSnapshot
    || require('../../routes/admin-estimates').buildEstimateSendSnapshot;
  // Lazy for the same load-order reason: the composer module is heavy and
  // the route already loads both.
  const customerHasOnlyPrimaryPremises = deps.customerHasOnlyPrimaryPremises
    || require('./cross-sell').customerHasOnlyPrimaryPremises;

  const nowDate = now();

  // ── Prior-mint lineage, from the ESTIMATES table itself ─────────────────
  // The open request row is NOT a reliable pointer (out-of-band audit P0):
  // staff can terminalize the request — and acceptance resolves it — after
  // which a fresh tap gets a fresh row with no linkage and would mint a
  // second live estimate at a possibly different honorable price. Every
  // mint stamps estimate_data.reportCtaMint.serviceKey, so the durable
  // lineage is a direct query: every live CTA mint for this customer +
  // service, found and LOCKED here, is either reused (identical offer) or
  // superseded before a new one may exist.
  const priorMintRows = await lockPriorMintLineage(trx, {
    customerId: customer.id,
    serviceKey: crossSell?.serviceKey,
  });
  const liveMints = (priorMintRows || []).filter((row) => priorMintStillLive(row, nowDate));
  // Every lineage row a fresh mint must permanently retire — live OR dead
  // (expired/declined), because an unarchived expired row can be REVIVED by
  // the public extension flow (in-hook audit r8 P0). Accepted/locked rows
  // stay untouched.
  // Staff-REVISED rows are never supersedable (GitHub #3391 round P0): the
  // revise dropped the fingerprint, so a later identical tap can't match
  // them for reuse — and archiving them would break the customer's
  // in-flight, possibly delivered, revised token. The blocker below refuses
  // the whole tap while one is live; this filter is the belt that keeps a
  // revised row out of the archival loop no matter what.
  const supersedableMints = (priorMintRows || []).filter((row) => (
    !row.archived_at && row.status !== 'accepted' && !row.price_locked_at
    && !reportCtaMintOf(row)?.fingerprintInvalidatedAt
  ));

  const context = crossSell?.engineContext;
  const option = crossSell?.option;
  if (!context?.propertyInput || !context?.targetOnlyServices || !option?.perVisit
    || !context?.primaryStreet || !context?.pricingSourceStamp || !context?.premisesProof) {
    throw new Error('click-to-estimate mint called without engine context');
  }

  // ── Staff-revised lineage BLOCKS the tap (GitHub #3391 round P0) ────────
  // A revise deliberately drops the offer fingerprint (staff just changed
  // the terms), so a revised row can never reuse — but archiving it would
  // break the customer's in-flight, possibly already DELIVERED token, and
  // minting BESIDE it puts two live honorable prices in the customer's
  // hands. Staff took over this conversation: the tap refuses as drift and
  // the revised estimate stays the one authoritative live offer.
  const staffRevisedBlocker = (priorMintRows || []).some((row) => (
    !row.archived_at && row.status !== 'accepted'
    && !!reportCtaMintOf(row)?.fingerprintInvalidatedAt
  ));
  if (staffRevisedBlocker) {
    throw new ClickEstimateDriftError('a staff-revised estimate holds this offer — the card is stale');
  }
  // The engine's tier logic speaks CANONICAL keys — the pricing-panel
  // loader maps termite_bait → termite for display parity, and replaying
  // that panel key would drop a termite customer's tier contribution and
  // 409 every tap as a phantom tier drift (GitHub #3391 round). Map back
  // before anything persists or replays.
  const canonicalQualifyingKey = (key) => (key === 'termite' ? 'termite_bait' : key);
  const priorQualifyingServices = (Array.isArray(context.currentServiceKeys)
    ? context.currentServiceKeys.filter(Boolean)
    : []).map(canonicalQualifyingKey);

  // ── Customer revalidation, BEFORE the reuse fast path ───────────────────
  // The composed customer row was read BEFORE this transaction's lock
  // (#3391 audit r2 P1); reuse must not return an estimate whose pricing
  // anchored to premises that have since changed (GitHub round: the
  // address-fanout rewrites the live estimate's address while its priced
  // snapshot stays stale — refuse and let the card refresh).
  const freshCustomer = await trx('customers').where({ id: customer.id }).first();
  if (!freshCustomer || freshCustomer.active === false || freshCustomer.deleted_at) {
    throw new Error('customer row vanished before click-to-estimate mint');
  }
  if (addressForCustomer(freshCustomer) !== addressForCustomer(customer)
    || String(freshCustomer.property_type || '') !== String(customer.property_type || '')) {
    throw new ClickEstimateDriftError('customer premises changed between pricing and mint');
  }
  // EVERY staff-writable price-bearing source, not just the premises pair
  // (GitHub #3391 round): the composition stamped the raw values it priced
  // from; re-read both rows under the lock and treat any change as offer
  // drift — the recompute replays captured facts, so it would only confirm
  // stale inputs.
  const freshTurf = await loadTurfProfile(trx, customer.id);
  const stamp = context.pricingSourceStamp;
  const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const strOrNull = (v) => (v === null || v === undefined ? null : String(v));
  const priceInputDrifted = [
    [numOrNull(stamp.lot_sqft), numOrNull(freshCustomer.lot_sqft)],
    [numOrNull(stamp.property_sqft), numOrNull(freshCustomer.property_sqft)],
    [numOrNull(stamp.bed_sqft), numOrNull(freshCustomer.bed_sqft)],
    [numOrNull(stamp.palm_count), numOrNull(freshCustomer.palm_count)],
    [strOrNull(stamp.lawn_type), strOrNull(freshCustomer.lawn_type)],
    [numOrNull(stamp.turf_lawn_sqft), numOrNull(freshTurf?.lawn_sqft)],
    [strOrNull(stamp.turf_track_key), strOrNull(freshTurf?.track_key ?? freshTurf?.grass_type ?? null)],
  ].some(([composed, fresh]) => composed !== fresh);
  if (priceInputDrifted) {
    throw new ClickEstimateDriftError('price-bearing property inputs changed between pricing and mint');
  }
  // A report the fallback SINGLE-PREMISES proof admitted stays priceable
  // only while the account stays single-premises (GitHub #3391 round P1):
  // the premises-pair and pricing-source checks above compare the PRIMARY
  // profile against itself, so a staff has_multi_home flip or a new
  // customer_properties row landing between composition and this lock is
  // invisible to them — and the report being priced may belong to that
  // newly evidenced secondary premises, the exact case the composer's
  // fallback proof suppresses. Re-run the SAME proof under the lock;
  // failure is offer drift, for reuse and mint alike. Linkage-proven
  // reports carry their own address evidence and skip this.
  if (context.premisesProof === 'single_premises'
    && !(await customerHasOnlyPrimaryPremises(trx, customer.id, freshCustomer, context.primaryStreet))) {
    throw new ClickEstimateDriftError('account premises evidence changed between pricing and mint');
  }

  // ── Reuse: identical offer, estimate already minted and still live ──────
  // Matched by FINGERPRINT against the locked lineage, NOT by the request
  // writer's dedupe verdict (GitHub round P0): staff terminalizing the
  // request — or a portal-home refresh of the shared row — makes the next
  // tap arrive deduped=false with the offer unchanged, and archiving the
  // live estimate the customer already holds would kill their token
  // mid-consideration.
  const fingerprintMatch = liveMints.find((row) => {
    const mark = reportCtaMintOf(row);
    return mark?.fingerprint && crossSell?.fingerprint && mark.fingerprint === crossSell.fingerprint;
  });
  const relinkRequestRow = async (match) => {
    // Relink the CURRENT request row when its snapshot lost (or never
    // had) the mint pointer — the durable lineage lives on the estimate,
    // but the advisory display linkage should follow the reuse.
    // mintedEstimate is excluded from the writer's dedupe compare, so
    // this cannot turn the next identical tap into a refresh.
    const requestMark = (() => {
      try {
        const rev = typeof requestRow.pricing_revision === 'string'
          ? JSON.parse(requestRow.pricing_revision)
          : requestRow.pricing_revision;
        return rev?.mintedEstimate || null;
      } catch { return null; }
    })();
    if (deduped || String(requestMark?.id || '') === String(match.id)) return null;
    const mark = reportCtaMintOf(match);
    return {
      pricing_revision: JSON.stringify({
        ...revisionSnapshot,
        mintedEstimate: {
          id: match.id,
          token: match.token,
          mintedAt: mark?.mintedAt || nowDate.toISOString(),
        },
      }),
      updated_at: nowDate,
    };
  };

  // ── Reuse fast path 1: the customer already ACCEPTED this offer ─────────
  // Their tap gets the accepted estimate back — and the fresh request row
  // resolves immediately (mirrors the accept path's own resolution): the
  // work is booked, staff must not be paged to follow up on it.
  if (fingerprintMatch && fingerprintMatch.status === 'accepted') {
    const relinkPatch = await relinkRequestRow(fingerprintMatch);
    await trx('service_requests').where({ id: requestRow.id }).update({
      ...(relinkPatch || { updated_at: nowDate }),
      status: 'resolved',
    });
    return {
      estimateId: fingerprintMatch.id,
      token: fingerprintMatch.token,
      url: estimatePathFor(fingerprintMatch.token),
      reused: true,
      // The request row was just resolved above — the work is BOOKED, so
      // the route must not page staff with the "Bundle inquiry" bell even
      // though the writer's outcome says deduped=false (acceptance resolved
      // the original request, so this tap inserted a fresh row) — GitHub
      // #3391 round P1.
      acceptedReuse: true,
    };
  }

  // Ownership revalidation INSIDE the transaction, BEFORE any unaccepted
  // reuse (in-hook audits r7+r8 P0): context.currentServiceKeys was loaded
  // at composition, before this customer lock — an acceptance or staff add
  // landing in between must neither mint NOR hand back a still-acceptable
  // estimate for a service the customer now owns (duplicate billing on
  // accept). The lineage lock only sees prior CTA mints. Same loader +
  // street-scope resolution the composition used; premises equality above
  // guarantees the same scope.
  const freshServices = await loadCurrentServiceKeys(trx, freshCustomer);
  if (freshServices.ownershipLookupFailed) {
    // FAIL CLOSED, retryable — unknown ownership must not publish a price
    // (same posture as the membership snapshot below).
    throw new Error('ownership revalidation failed before click-to-estimate mint');
  }
  const mapOwnKey = (key) => (key === 'termite_bait' ? 'termite' : key);
  const nowHeldKeys = new Set([
    ...freshServices.currentServiceKeys, ...freshServices.ownedServiceKeys,
  ].map(mapOwnKey));
  if (nowHeldKeys.has(mapOwnKey(crossSell.serviceKey))) {
    throw new ClickEstimateDriftError('target service is now owned — offer is stale');
  }
  // The qualifying baseline priced the card (priors union into the tier):
  // any change — added OR removed — is a different price basis. Refuse as
  // drift; the next report render re-composes against the new baseline.
  const freshQualifying = new Set(freshServices.currentServiceKeys.map(mapOwnKey));
  const pricedQualifying = new Set(priorQualifyingServices.map(mapOwnKey));
  if (freshQualifying.size !== pricedQualifying.size
    || [...pricedQualifying].some((key) => !freshQualifying.has(key))) {
    throw new ClickEstimateDriftError('qualifying services changed between pricing and mint');
  }

  // ── Reuse fast path 2: identical UNACCEPTED offer, still live ───────────
  // Matched by FINGERPRINT against the locked lineage, NOT by the request
  // writer's dedupe verdict (GitHub round P0): staff terminalizing the
  // request — or a portal-home refresh of the shared row — makes the next
  // tap arrive deduped=false with the offer unchanged, and archiving the
  // live estimate the customer already holds would kill their token
  // mid-consideration. Runs AFTER every revalidation above: a stale offer
  // never reuses any more than it mints.
  if (fingerprintMatch) {
    const relinkPatch = await relinkRequestRow(fingerprintMatch);
    if (relinkPatch) {
      await trx('service_requests').where({ id: requestRow.id }).update(relinkPatch);
    }
    return {
      estimateId: fingerprintMatch.id,
      token: fingerprintMatch.token,
      url: estimatePathFor(fingerprintMatch.token),
      reused: true,
    };
  }

  // ── Mint ────────────────────────────────────────────────────────────────

  // The persisted replay input: the card's exact property facts + the target
  // service ALONE. Identity (priorQualifyingServices / recurringCustomer) is
  // deliberately NOT baked in — serverRecomputeFromEstimateData strips
  // client-claimable identity and re-applies it from the server-derived deps,
  // and the public page re-injects estimate_data.priorQualifyingServices on
  // every replay (extractEngineInputs), so display and accept keep pricing at
  // the combined tier without a forgeable input field. Identity fields
  // persist from freshCustomer — re-read and drift-checked above.
  const estimateData = {
    engineInputs: {
      ...context.propertyInput,
      services: context.targetOnlyServices,
    },
    ...(priorQualifyingServices.length ? { priorQualifyingServices } : {}),
    // Durable opt-out from estimate engagement automation (#3391 audit P1):
    // the four followup_* flags only cover the follow-up engine — the
    // engagement engine's view-event and quiet-sweep rules key on
    // status/sent_at and would email a customer this exception promises
    // ZERO comms. Enforced centrally in estimate-engagement-engine.
    noEngagementAutomation: true,
    reportCtaMint: {
      // serviceKey is the durable lineage key the prior-mint query above
      // resolves supersession through — the request row is advisory only.
      serviceKey: crossSell.serviceKey,
      serviceRecordId: service.id,
      requestId: requestRow.id,
      fingerprint: crossSell.fingerprint || null,
      shownPerApplication: option.perVisit,
      mintedAt: nowDate.toISOString(),
      ...(supersedableMints.length ? { supersededEstimateIds: supersedableMints.map((r) => r.id) } : {}),
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
  // A tiered card must recompute to the SAME tier — a missing recomputed
  // tier is a mismatch too, not a pass (codex cloud-task tightening): the
  // card promised combined-tier terms this estimate would not carry.
  if (option.waveguardTier && option.waveguardTier !== serverTier) {
    throw new ClickEstimateDriftError(
      `minted WaveGuard tier would not match the card (card=${option.waveguardTier} server=${serverTier})`,
    );
  }
  // One-time-charge belt (GitHub round P1): the card is a per-application
  // promise, so the minted estimate may not carry a one-time charge the
  // customer can't see before accepting. The ONE permitted component is the
  // line-declared initialFee (the standing membership fee): the estimate
  // page itemizes it before acceptance — the owner's copy ruling names that
  // page as the disclosure surface — and priced pest cards are live,
  // owner-verified behavior. Anything BEYOND the declared fee is money the
  // flow never surfaces: refuse.
  const declaredSetupFees = (recomputed.rawEngineResult?.lineItems || [])
    .reduce((sum, li) => sum + (Number(li?.initialFee) > 0 ? Number(li.initialFee) : 0), 0);
  const beltOneTime = Number(recomputed.serverTotals?.onetimeTotal || 0);
  if (beltOneTime > declaredSetupFees + 0.005) {
    throw new ClickEstimateDriftError(
      `minted estimate carries an undisclosed one-time total (${beltOneTime} > declared ${declaredSetupFees})`,
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
    // Same primary-property street scope the card's pricing frames used
    // (GitHub round P1): an unscoped snapshot loads qualifying rows
    // account-wide, and the converter trusts those keys at acceptance — a
    // secondary property's services would inflate the accepted WaveGuard
    // tier beyond what the displayed price modeled.
    membershipSnapshot = await computeMembershipContext(trx, {
      customerId: customer.id,
      streetScope: {
        estimateStreet: context.primaryStreet,
        customerPrimaryStreet: context.primaryStreet,
        requireSharedLocality: true,
      },
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
    // Identity fields come from the row re-read UNDER the transaction lock
    // (equal on the premises fields by the drift check above): a profile
    // edit that landed between pricing and this tap reaches the estimate.
    address: addressForCustomer(freshCustomer) || null,
    customer_id: freshCustomer.id,
    customer_name: `${freshCustomer.first_name || ''} ${freshCustomer.last_name || ''}`.trim() || null,
    customer_phone: freshCustomer.phone || null,
    customer_email: freshCustomer.email || null,
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
    // The engine version that actually priced this row (GitHub round P2):
    // the column default is the legacy 'v4.2', and audit/metadata readers
    // prefer the column — same stamp rule as buildEstimatePersistenceFields.
    ...(typeof recomputed.serverResult?.engineVersion === 'string'
      ? { pricing_version: recomputed.serverResult.engineVersion.slice(0, 80) }
      : {}),
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

  // Supersede EVERY prior lineage row for this offer (locked above) — live
  // AND dead (in-hook audit r8 P0): two live links at two honorable prices
  // is the exact ambiguity the price-lock ruling exists to prevent, and an
  // EXPIRED prior is not safe to skip — the public extension-request flow
  // can revive an unarchived sent_at row for seven more days, resurrecting
  // the old price beside this replacement. Archival is the one durable
  // no-revive state. Accepted/locked rows are never touched (acceptance
  // already spun up downstream records).
  for (const row of supersedableMints) {
    await trx('estimates')
      .where({ id: row.id })
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

  return { estimateId: created.id, token, url: estimatePathFor(token), reused: false };
}

module.exports = { mintReportClickEstimate, ClickEstimateDriftError, priorMintStillLive };
