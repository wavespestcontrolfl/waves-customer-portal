'use strict';

/**
 * Plan restart (C4, GATE_CANCEL_FLOW_V2) — a CANCELLED customer taps
 * "Restart my plan" and lands on a normal, server-priced estimate for the
 * families they cancelled, which they accept through the existing public
 * estimate path (card-first on every accept, unchanged).
 *
 * Owner rulings honored here:
 *   - Restart ALWAYS reprices at the current price and asks for approval —
 *     nothing here restores an old rate or tier.
 *   - No parallel pricing path: the property context, engine inputs, and
 *     per-service option shapes are the customer-pricing-ai exports the
 *     one-tap and click-to-estimate lanes already reuse; the price is
 *     serverRecomputeFromEstimateData (the SAME server-authoritative
 *     recompute every builder save and click-mint runs); the row is
 *     published with the click-mint's publish-without-delivery pattern
 *     (status 'sent', follow-up flags pre-burned, engagement automation
 *     opted out) so nothing ever messages the customer about it.
 *   - Setup fee / existing-member terms: whatever the existing rule does.
 *     computeMembershipContext returns null for an inactive customer, so a
 *     restart estimate carries new-customer terms — no waiver is invented.
 *   - Customer-initiated only. No win-back send of any kind.
 *
 * Scope = the customer's most recent COMMITTED cancellation_cases row: a
 * non-empty `scope` names the families; `[]` means the whole prior plan,
 * recovered from the recurring rows the cancellation processor pulled, then
 * from the scoped churn note (the only note that names families).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { FAMILY_LABELS } = require('./templates');
const { lockCustomerComms } = require('../../utils/customer-comms-lock');

const SOURCE = 'plan_restart';
const RESTARTABLE_FAMILIES = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'];
// Pricing-ai speaks 'termite' for the termite_bait family (LINE_SERVICE_KEYS).
const pricingKeyFor = (family) => (family === 'termite_bait' ? 'termite' : family);

class RestartUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.restartUnavailable = true;
  }
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Families the customer cancelled, tied to the LATEST cancellation attempt.
// The processor stamps this attempt's rows before the case row exists, so
// "belongs to the latest attempt" tolerates an hour of skew.
const ATTEMPT_SLACK_MS = 60 * 60 * 1000;
function attemptBoundFor(caseCreatedAt) {
  const t = new Date(caseCreatedAt).getTime();
  return Number.isNaN(t) ? caseCreatedAt : new Date(t - ATTEMPT_SLACK_MS).toISOString();
}

async function cancelledFamiliesFor(customerId, dbh = db) {
  // Newest case regardless of status: when a cancellation partially
  // completes (case left 'open' while the customer is already stamped
  // churned), an OLDER committed case's scope must never answer for it —
  // recovery falls through to the rows of THIS attempt instead.
  const latest = await dbh('cancellation_cases')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .first('id', 'scope', 'status', 'created_at', 'service_request_id');
  const scope = latest && latest.status === 'committed' ? parseJson(latest.scope, []) : [];
  const scoped = (Array.isArray(scope) ? scope : []).filter((f) => RESTARTABLE_FAMILIES.includes(f));
  if (scoped.length) return { families: scoped, caseId: latest.id, source: 'case_scope' };

  // Whole account ([]), uncommitted latest case, or no case row: the
  // recurring rows the processor cancelled name the prior plan. Cancelled
  // rows carry no recurring_ongoing signal any more, so read the family off
  // the row/catalog text the same way the facts loader does for live rows.
  // When a case exists, only rows cancelled during THAT attempt count — a
  // historically cancelled family from an earlier cancellation must not
  // sneak into the quote.
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  const { CHURN_REASON, PORTAL_CANCEL_REASON_PREFIX } = require('../cancellation-processor');
  let rowsQuery = dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where('s.status', 'cancelled')
    .where('s.is_recurring', true)
    .where(function notCallback() { this.whereNull('s.is_callback').orWhere('s.is_callback', false); })
    .orderBy('s.cancelled_at', 'desc')
    // No LIMIT: this is family EVIDENCE run through the JS classifier — a
    // big attempt's newest rows could all belong to one family and starve
    // the rest out of the quote (codex GH r7 P2). Narrowed by status +
    // recurring + reason + one customer_id.
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  if (latest && latest.service_request_id) {
    // Exact correlation: the processor stamps every row THIS request pulls
    // with "Portal cancellation request <id>" verbatim, and the case row
    // records that id — so when the linkage exists, only those rows are
    // this attempt's evidence. A prefix/time-window match would also accept
    // a prior cancellation inside the slack hour after a reactivation
    // (codex GH r7 P1). The window fallback below stays for legacy cases
    // without the linkage.
    rowsQuery = rowsQuery.where('s.cancellation_reason', `${PORTAL_CANCEL_REASON_PREFIX} ${latest.service_request_id}`);
  } else {
    // A customer-driven cancellation's reason is either the bare default or
    // the request-scoped "Portal cancellation request <id>" every
    // requests.js path passes (codex GH r5 P1: matching only the default
    // made every ordinary whole-account restart find zero rows).
    rowsQuery = rowsQuery.where(function customerCancelReason() {
      this.where('s.cancellation_reason', CHURN_REASON)
        .orWhere('s.cancellation_reason', 'like', `${PORTAL_CANCEL_REASON_PREFIX}%`);
    });
  }
  if (latest && latest.created_at) {
    // Slack window: the H0 request path runs the processor BEFORE it writes
    // the case row, so this attempt's rows carry cancelled_at slightly
    // EARLIER than the case's created_at. An hour of slack keeps them in
    // while still excluding a genuinely earlier cancellation's families.
    rowsQuery = rowsQuery.where('s.cancelled_at', '>=', attemptBoundFor(latest.created_at));
  }
  const rows = await rowsQuery;
  const keys = [];
  for (const row of rows) {
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!keys.includes(key)) keys.push(key);
  }
  const fromRows = uniqueServiceFamilies(keys).filter((f) => RESTARTABLE_FAMILIES.includes(f));
  if (fromRows.length) return { families: fromRows, caseId: latest ? latest.id : null, source: 'cancelled_rows' };

  // Last resort: the scoped-cancel audit note ("Cancelled Pest Control, Lawn
  // Care — plan continues with …") names families by label — again bounded
  // to the latest attempt when a case exists.
  let noteQuery = dbh('customer_interactions')
    .where({ customer_id: customerId, interaction_type: 'note' })
    .where('subject', 'like', 'Cancelled %')
    .orderBy('created_at', 'desc');
  if (latest && latest.created_at) noteQuery = noteQuery.where('created_at', '>=', attemptBoundFor(latest.created_at));
  const note = await noteQuery.first('subject');
  if (note && note.subject) {
    const named = String(note.subject).split(' — ')[0].replace(/^Cancelled\s+/, '');
    const fromNote = Object.entries(FAMILY_LABELS)
      .filter(([, label]) => named.includes(label))
      .map(([key]) => key)
      .filter((f) => RESTARTABLE_FAMILIES.includes(f));
    if (fromNote.length) return { families: fromNote, caseId: latest ? latest.id : null, source: 'churn_note' };
  }
  return { families: [], caseId: latest ? latest.id : null, source: 'none' };
}

// The families with residual LIVE recurring obligations on this account —
// two kinds of evidence, matching cancellation-eligibility's own view of a
// live obligation: (a) non-terminal recurring rows, and (b) a series anchor
// re-armed with recurring_ongoing=true (staff can restore a family on a
// completed anchor before its next occurrence exists, and that family is
// owned, not restartable). The pricing-ai ownership loaders deliberately
// answer [] for an inactive customer (loadActiveRecurringServiceRows), so
// the churned lanes read the residual rows directly — same family detection
// as the cancelled-family recovery. Throws when the rows cannot be read;
// every caller FAILS CLOSED on that.
async function ownedResidualFamilies(dbh, customerId) {
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  const { TERMINAL_STATUSES } = require('../waveguard-existing-services');
  const residualBase = () => dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where(function notCallback() { this.whereNull('s.is_callback').orWhere('s.is_callback', false); })
    // No LIMIT: this is ownership EVIDENCE, and an arbitrary truncation
    // could drop an entire residual family (recurring_ongoing rides on
    // every historical row of a series) and let restart re-sell an owned
    // service (codex GH r6 P1). Both reads are already narrowed by their
    // status/flag predicates below and scoped to one customer.
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  const [nonTerminalRows, ongoingAnchorRows] = await Promise.all([
    residualBase().whereNotIn('s.status', TERMINAL_STATUSES).where('s.is_recurring', true),
    residualBase().where('s.recurring_ongoing', true),
  ]);
  const residualKeys = [];
  for (const row of [...nonTerminalRows, ...ongoingAnchorRows]) {
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!residualKeys.includes(key)) residualKeys.push(key);
  }
  return uniqueServiceFamilies(residualKeys);
}

// A prior restart estimate the customer can still open (same liveness the
// click-mint applies to its own lineage).
function liveRestartEstimate(rows, now) {
  return (rows || []).find((row) => {
    if (!row || row.archived_at || row.status === 'accepted') return false;
    if (!['sent', 'viewed'].includes(String(row.status || ''))) return false;
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    return !(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now);
  });
}

async function mintRestartEstimate({ customer, now = () => new Date(), randomBytes = crypto.randomBytes, deps = {} }) {
  if (!customer || !customer.id) throw new Error('mintRestartEstimate requires a customer row');
  const persistence = deps.persistence || require('../admin-estimate-persistence');
  const pricingAi = deps.pricingAi || require('../customer-pricing-ai');
  const { pricingBundleMatchesEstimateTotals } = deps.bundleUtils || require('../estimate-pricing-bundle-utils');
  // Route adapter, lazy for the same service→route load-order reason the
  // click-mint cites.
  const buildEstimateSendSnapshot = deps.buildEstimateSendSnapshot
    || require('../../routes/admin-estimates').buildEstimateSendSnapshot;
  const dbh = deps.db || db;
  const nowDate = now();

  return dbh.transaction(async (trx) => {
    // Customer-comms advisory lock FIRST (lock-order contract §1,
    // utils/customer-comms-lock.js — before this txn's own customers row
    // lock). It is also the FIRST lock the public accept transaction takes
    // for a customer-linked estimate, so a mint racing an accept serializes
    // at the advisory level before either takes a row lock — closing the
    // customers-row vs estimates-row AB-BA between the two C4 paths (mint
    // locks customer → archives estimates; accept locks estimate →
    // revalidates customer).
    await lockCustomerComms(trx, customer.id);
    // Lock the customer row: a double-tap must not mint two restart estimates.
    const fresh = await trx('customers').where({ id: customer.id }).whereNull('deleted_at').forUpdate().first();
    if (!fresh) throw new RestartUnavailableError('not_cancelled', 'This account is not cancelled.');
    // Exactly the processor's stamp, re-verified under the lock: active
    // EXPLICITLY false. A row drifting to active=NULL is not a processed
    // cancellation and must not mint (same rule as the middleware).
    if (fresh.active !== false || fresh.pipeline_stage !== 'churned') {
      throw new RestartUnavailableError('not_cancelled', 'This account is not cancelled.');
    }

    // Commercial properties never get an online restart price (codex
    // pre-push P0 — same doctrine as BOTH offer surfaces, cross-sell
    // report + portal offer: the engine refuses real prices there and
    // commercial expansion is a proposal conversation; variantsForService
    // below only knows residential defaults). Checked on the STORED type
    // here, BEFORE any reuse or mint, and re-checked on the RESOLVED type
    // after the property context is built — a cached lookup classifying
    // the property commercial must refuse too. FAIL CLOSED: a check that
    // cannot be evaluated refuses.
    const isCommercial = deps.isCommercialProperty
      || require('../pricing-engine/commercial-helpers').isCommercialProperty;
    const refuseCommercial = () => new RestartUnavailableError('pricing_unavailable', 'This restart needs to be set up by hand — please call or text us and we will take care of it.');
    const assertNotCommercial = (property, label) => {
      let commercial = true;
      try {
        commercial = isCommercial(property);
      } catch (err) {
        logger.warn(`[plan-restart] commercial check (${label}) failed for ${fresh.id} — refusing: ${err.message}`);
        throw refuseCommercial();
      }
      if (commercial) throw refuseCommercial();
    };
    assertNotCommercial({ propertyType: fresh.property_type }, 'stored');

    const { families, caseId, source } = await cancelledFamiliesFor(fresh.id, trx);
    if (!families.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'We could not find the plan to restart from this account.');
    }

    // Ownership — FAIL CLOSED: a family with LIVE recurring rows on this
    // account is never re-priced beside its live rate. Same residual read
    // the accept-time revalidation runs (assertRestartAcceptEligible).
    let ownedFamilies;
    try {
      ownedFamilies = await ownedResidualFamilies(trx, fresh.id);
    } catch (err) {
      logger.warn(`[plan-restart] residual ownership lookup failed for ${fresh.id} — refusing: ${err.message}`);
      throw new RestartUnavailableError('pricing_unavailable', 'We could not verify your services just now. Please try again in a moment.');
    }
    const owned = new Set(ownedFamilies.map(pricingKeyFor));
    // The families this mint may actually quote: cancelled minus residual.
    const eligibleFamilies = families.filter((f) => !owned.has(pricingKeyFor(f)));
    const toPrice = eligibleFamilies.map(pricingKeyFor);
    if (!toPrice.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'Those services are already active on this account.');
    }

    // Single-premises proof BEFORE any URL is handed out (codex GH r4 P1):
    // the cancelled-family and residual queries above are scoped by
    // customer_id alone, but the estimate is priced and addressed at the
    // single primary street — a family cancelled at a SECONDARY premises
    // would otherwise be quoted at the primary property's measurements.
    // Same proof the portal offer runs (customerHasOnlyPrimaryPremises,
    // cross-sell): a multi-premises profile — or a proof that cannot be
    // evaluated, a missing primary street, or a street without provable
    // locality — is the priced-by-hand 409, never an online price.
    const crossSell = deps.crossSell || require('../service-report/cross-sell');
    const linkage = require('../estimate-property-linkage');
    const primaryStreet = linkage.normalizedStampedStreet(fresh.address_line1, fresh.address_line2, fresh.city, fresh.zip);
    let singlePremises = false;
    try {
      const premisesProof = deps.customerHasOnlyPrimaryPremises
        || require('../service-report/cross-sell').customerHasOnlyPrimaryPremises;
      singlePremises = Boolean(primaryStreet)
        && !linkage.scopeKeyLacksLocality(primaryStreet)
        && await premisesProof(trx, fresh.id, fresh, primaryStreet);
    } catch (err) {
      logger.warn(`[plan-restart] single-premises proof failed for ${fresh.id} — refusing: ${err.message}`);
      singlePremises = false;
    }
    if (!singlePremises) {
      throw new RestartUnavailableError('pricing_unavailable', 'This restart needs to be set up by hand — please call or text us and we will take care of it.');
    }

    // Reuse a live restart estimate ONLY after the scope + ownership checks
    // above, and only when it quotes exactly today's eligible families — a
    // quote minted before staff restored a service, or before a
    // re-cancellation changed the scope, is archived and re-priced instead
    // of handed back stale (idempotent button; one honorable price at a
    // time).
    const priorRows = await trx('estimates')
      .where({ customer_id: fresh.id, source: SOURCE })
      .whereNull('archived_at')
      .orderBy('created_at', 'desc')
      .limit(10);
    const live = liveRestartEstimate(priorRows, nowDate);
    if (live) {
      // Compare against the ELIGIBLE set, not the raw cancellation scope —
      // a quote minted before staff restored one of its families would
      // otherwise re-sell the now-live service.
      const liveFamilies = parseJson(live.estimate_data, {})?.planRestart?.families;
      const sameScope = Array.isArray(liveFamilies)
        && liveFamilies.length === eligibleFamilies.length
        && [...liveFamilies].sort().join(',') === [...eligibleFamilies].sort().join(',');
      if (sameScope) {
        return { estimateId: live.id, token: live.token, url: `/estimate/${live.token}`, reused: true };
      }
    }
    // Minting a replacement: archive the WHOLE unaccepted restart lineage
    // first — not just a scope-mismatched live row. An EXPIRED restart quote
    // left unarchived stays revivable for seven days through
    // /extension-request (restart mints stamp sent_at), which would put an
    // older price or cancellation scope back in the wild beside the new
    // quote (codex GH r6 P1). Query-shaped (not the limit-10 id list) so no
    // straggler row survives; accepted rows are history and stay.
    await trx('estimates')
      .where({ customer_id: fresh.id, source: SOURCE })
      .whereNull('archived_at')
      .whereNot('status', 'accepted')
      .update({ archived_at: nowDate, updated_at: nowDate });

    // Property context: profile first, then the SAME cache-only lookup +
    // accepted-estimate seed discipline the portal offer surfaces price
    // under (cross-sell/one-tap). No LIVE lookup spend from a restart tap —
    // a cached lookup row or a prior accepted estimate for THIS street
    // supplies the footprint the stored profile lacks.
    let propertySeed = null;
    try {
      propertySeed = await crossSell.loadEstimateSeed(trx, fresh.id, primaryStreet);
    } catch (err) {
      logger.warn(`[plan-restart] estimate property seed skipped for ${fresh.id}: ${err.message}`);
    }
    const turfProfile = await pricingAi.loadTurfProfile(trx, fresh.id);
    // Verified-correction probe discipline (codex GH r4 P1), mirrored from
    // BOTH offer paths (cross-sell report + portal offer): only a USABLE
    // lookup result carries staff's verified overrides folded in, so record
    // whether one came back. When none does — a miss, a payload the resolver
    // rejects (global verify flag), or no lookup at all — the price falls
    // back to stored fields + the accepted-estimate seed, both OLDER than a
    // technician's verified correction. Probed below, after the resolve.
    const providedLookup = 'propertyLookup' in deps ? deps.propertyLookup : crossSell.cacheOnlyPropertyLookup;
    const { hasGlobalVerifyFlag } = require('../lookup-confidence');
    let lookupProducedResult = false;
    const trackedLookup = typeof providedLookup === 'function'
      ? async (address) => {
        const found = await providedLookup(address);
        if (found && !hasGlobalVerifyFlag(found.enriched || {})) lookupProducedResult = true;
        return found;
      }
      : providedLookup;
    const propertyContext = await pricingAi.resolvePropertyContext({
      customer: fresh,
      turfProfile,
      propertyLookup: trackedLookup,
      propertySeed,
    });
    // Commercial re-check on the RESOLVED type (codex pre-push P0, same as
    // the offer paths' post-resolve re-check): the stored column can be
    // blank/stale while the cached lookup or the accepted-estimate seed
    // classified the property commercial — that resolution must refuse,
    // not price through residential defaults.
    assertNotCommercial({ propertyType: propertyContext?.propertyInput?.propertyType }, 'resolved');
    const missing = pricingAi.missingPropertyFor(toPrice, propertyContext);
    if (missing) {
      throw new RestartUnavailableError('pricing_unavailable', 'We need a property measurement on file before we can price this online.');
    }
    // No lookup result means any verified correction on this address was NOT
    // applied to the price. FAIL CLOSED, same as the offer paths' demote: an
    // unreadable probe is not evidence that no corrections exist, and a
    // correction on file makes this the priced-by-hand 409 instead of an
    // exact price on a fact staff already fixed.
    if (!lookupProducedResult) {
      let correctionsUnapplied = false;
      try {
        const probe = deps.hasVerifiedOverrides
          || require('../property-lookup/lookup-cache').hasVerifiedOverrides;
        correctionsUnapplied = await probe(pricingAi.addressForCustomer(fresh));
      } catch (err) {
        correctionsUnapplied = true;
        logger.warn(`[plan-restart] verified-override probe failed for ${fresh.id} — refusing: ${err.message}`);
      }
      if (correctionsUnapplied) {
        throw new RestartUnavailableError('pricing_unavailable', 'This one needs a quick hand-check before we can price it online.');
      }
    }

    const context = { grassType: propertyContext.grassType, palmCount: propertyContext.palmCount };
    const services = {};
    for (const key of toPrice) {
      const [option] = pricingAi.variantsForService(key, '', true);
      if (!option) continue;
      Object.assign(services, pricingAi.optionServices(option, context));
    }
    if (!Object.keys(services).length) {
      throw new RestartUnavailableError('pricing_unavailable', 'We could not price this plan online.');
    }

    const estimateData = {
      engineInputs: { ...propertyContext.propertyInput, services },
      // No follow-up / engagement automation may ever message the customer
      // about an estimate they asked for and are looking at (click-mint
      // doctrine; enforced centrally in estimate-engagement-engine).
      noEngagementAutomation: true,
      planRestart: {
        // The QUOTED families (reuse compares against these); the raw
        // cancellation scope rides alongside for the audit trail.
        families: eligibleFamilies,
        cancelledFamilies: families,
        familiesSource: source,
        cancellationCaseId: caseId,
        mintedAt: nowDate.toISOString(),
      },
    };
    // priorQualifyingServices from the SERVER-derived residual set —
    // normally empty for a cancelled customer, so the engine prices at
    // today's list; a family they somehow still hold prices the restart at
    // the combined tier instead of standalone. Already family-canonical.
    const priorQualifyingServices = [...ownedFamilies];
    const recomputed = await persistence.serverRecomputeFromEstimateData(estimateData, {
      priorQualifyingServices,
      recurringCustomer: priorQualifyingServices.length > 0,
    });
    if (!recomputed?.recomputed) {
      throw new Error(`plan-restart recompute failed (${recomputed?.reason || 'unknown'})`);
    }

    // FAIL CLOSED on review markers, the same demotion the offer path's
    // optionIsPriceable applies: an engine result flagged for on-site
    // verification, manual review, or low confidence — or a seed whose
    // source estimate carried its own verification markers — never becomes
    // a customer-visible price. The customer gets the priced-by-hand 409.
    const raw = recomputed.rawEngineResult || {};
    const flaggedLine = (raw.lineItems || []).some((l) => l && (
      l.customQuoteFlag === true
      || l.requiresManualReview === true
      || String(l.pricingConfidence || '').toLowerCase() === 'low'
      || String(l.turfConfidence || '').toLowerCase() === 'low'
    ));
    if (flaggedLine
      || (Array.isArray(raw.fieldVerify) && raw.fieldVerify.length > 0)
      || propertySeed?.requiresFieldVerification === true) {
      throw new RestartUnavailableError('pricing_unavailable', 'This one needs a quick hand-check before we can price it online.');
    }

    estimateData.result = recomputed.serverResult;
    if (recomputed.pestPricingVersion && estimateData.engineInputs.services.pest
      && typeof estimateData.engineInputs.services.pest === 'object') {
      estimateData.engineInputs.services.pest.version = recomputed.pestPricingVersion;
    }

    const totals = recomputed.serverTotals || {};
    const monthlyTotal = Number(totals.monthlyTotal || 0);
    const annualTotal = Number(totals.annualTotal || 0) || monthlyTotal * 12;
    const onetimeTotal = Number(totals.onetimeTotal || 0);
    const serverTier = recomputed.rawEngineResult?.waveGuard?.tier
      || recomputed.rawEngineResult?.waveGuard?.label || null;

    const token = randomBytes(16).toString('hex');
    const [created] = await trx('estimates').insert({
      estimate_data: JSON.stringify(estimateData),
      address: pricingAi.addressForCustomer(fresh) || null,
      customer_id: fresh.id,
      customer_name: `${fresh.first_name || ''} ${fresh.last_name || ''}`.trim() || null,
      customer_phone: fresh.phone || null,
      customer_email: fresh.email || null,
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      onetime_total: onetimeTotal,
      waveguard_tier: serverTier,
      token,
      expires_at: persistence.estimateExpiresAt(now),
      notes: null,
      // Publish without delivery (click-mint pattern): viewable + acceptable
      // now, every follow-up flag pre-burned.
      status: 'sent',
      sent_at: nowDate,
      followup_unviewed_sent: true,
      followup_viewed_sent: true,
      followup_final_sent: true,
      followup_expiring_sent: true,
      source: SOURCE,
      service_interest: eligibleFamilies.map((f) => FAMILY_LABELS[f] || f).join(' + '),
      category: fresh.property_type === 'commercial' ? 'COMMERCIAL' : 'RESIDENTIAL',
      pricing_authority: 'SERVER',
      server_computed_price: annualTotal > 0 ? annualTotal : null,
      ...(typeof recomputed.serverResult?.engineVersion === 'string'
        ? { pricing_version: recomputed.serverResult.engineVersion.slice(0, 80) }
        : {}),
    }).returning('*');

    // Freeze the send snapshot so the public page replays the shown price
    // instead of live config — a snapshot that failed to freeze is a
    // publication failure (sibling-publication rule), never a warning.
    const withSnapshot = await buildEstimateSendSnapshot(created, now);
    if (!withSnapshot?.sendSnapshot || withSnapshot.sendSnapshot.pricingBundleError) {
      throw new Error(`plan-restart send snapshot did not freeze pricing${withSnapshot?.sendSnapshot?.pricingBundleError ? `: ${withSnapshot.sendSnapshot.pricingBundleError}` : ''}`);
    }
    if (!pricingBundleMatchesEstimateTotals(withSnapshot.sendSnapshot.pricingBundle, created)) {
      throw new Error('plan-restart send snapshot does not match the minted totals');
    }
    await trx('estimates').where({ id: created.id }).update({
      estimate_data: JSON.stringify(withSnapshot),
      updated_at: nowDate,
    });

    // Audit trail on the customer's timeline — no bell, no customer send.
    // NOT swallowed: a failed statement aborts the whole Postgres
    // transaction, so "tolerating" it would turn the COMMIT into a silent
    // ROLLBACK while we still hand back a URL for an estimate that no
    // longer exists. The mint fails atomically instead.
    await trx('customer_interactions').insert({
      customer_id: fresh.id,
      interaction_type: 'note',
      subject: `Restart estimate requested from portal — ${eligibleFamilies.map((f) => FAMILY_LABELS[f] || f).join(', ')}`,
      body: `Customer opened a restart estimate (${created.id}) priced at today's rates. Accepting it restarts the plan.`,
    });

    logger.info(`[plan-restart] minted estimate ${created.id} for customer ${fresh.id} (${eligibleFamilies.join(',')} via ${source})`);
    return { estimateId: created.id, token, url: `/estimate/${token}`, reused: false };
  });
}

// Accept-time revalidation (codex GH r4 P1) — called from the public
// estimate accept transaction AFTER it takes the estimate row lock. The
// residual-ownership exclusion in the mint runs at MINT time only, but the
// published estimate stays acceptable until expiry: staff restoring a
// family (or reactivating the whole account) between mint and accept would
// let the old token accept a quote containing a now-live family — and the
// AGENTS.md bound on this exception is that a live recurring rate is never
// re-priced. Re-check the exact churn stamp and re-run the SAME residual
// read against the QUOTED families, under the lock. FAIL CLOSED: drifted or
// unreadable state refuses the accept with a 409 the portal can render.
async function assertRestartAcceptEligible(trx, estimate) {
  const refuse = (message) => {
    const err = new Error(message);
    err.status = 409;
    err.code = 'RESTART_STATE_CHANGED';
    return err;
  };
  const changed = () => refuse('This account changed since this restart quote was created — please reopen "Restart my plan" for a current quote.');
  let quoted;
  let fresh;
  let ownedFamilies;
  try {
    // Fresh in-transaction read: the accept path locked this row FOR UPDATE
    // just above, so this sees the committed truth, not the handler's
    // pre-transaction snapshot.
    const row = await trx('estimates').where({ id: estimate.id }).first('customer_id', 'estimate_data');
    const planRestart = parseJson(row?.estimate_data, {})?.planRestart;
    quoted = Array.isArray(planRestart?.families) ? planRestart.families : null;
    // Serialize against reactivation/restoration BEFORE the eligibility
    // reads (codex pre-push P1): the estimate row lock fences neither the
    // customers row nor scheduled_services, so a concurrent staff
    // reactivation or row restoration could commit between plain reads
    // here and this accept's commit. Locks, in the repo's established
    // order (customer-comms-lock.js contract §1):
    //   1. the per-customer comms advisory key — the accept txn already
    //      holds it as its FIRST lock (reentrant, contract §3), and it is
    //      the key every scheduled_services-inserting restoration writer
    //      takes, so those serialize here;
    //   2. the customers row FOR UPDATE — a reactivation is an UPDATE on
    //      this row, so it now commits strictly before or after this
    //      check, never inside it.
    // The eligibility reads below run AFTER both locks.
    await lockCustomerComms(trx, row?.customer_id);
    fresh = row?.customer_id
      ? await trx('customers').where({ id: row.customer_id }).whereNull('deleted_at').forUpdate().first('id', 'active', 'pipeline_stage')
      : null;
    ownedFamilies = fresh ? await ownedResidualFamilies(trx, fresh.id) : [];
  } catch (err) {
    logger.warn(`[plan-restart] accept revalidation could not read state for estimate ${estimate.id} — refusing: ${err.message}`);
    throw refuse('We could not re-verify this restart just now — please try again in a moment.');
  }
  // A plan_restart estimate without its quoted families (or its customer)
  // is malformed — never accept it.
  if (!quoted || !quoted.length || !fresh) throw changed();
  // Exactly the processor's churn stamp, same rule as the mint's locked
  // re-check: anything else means staff reactivated the account.
  if (fresh.active !== false || fresh.pipeline_stage !== 'churned') throw changed();
  // A quoted family that went live again since the mint is a live rate this
  // accept would re-price — refuse; the customer re-taps for a fresh quote.
  const owned = new Set(ownedFamilies.map(pricingKeyFor));
  if (quoted.some((f) => owned.has(pricingKeyFor(f)))) throw changed();
}

module.exports = {
  SOURCE,
  RESTARTABLE_FAMILIES,
  RestartUnavailableError,
  cancelledFamiliesFor,
  mintRestartEstimate,
  assertRestartAcceptEligible,
  _test: { liveRestartEstimate, ownedResidualFamilies },
};
