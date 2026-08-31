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

// Families the customer cancelled, newest committed case first.
async function cancelledFamiliesFor(customerId, dbh = db) {
  const latest = await dbh('cancellation_cases')
    .where({ customer_id: customerId, status: 'committed' })
    .orderBy('created_at', 'desc')
    .first('id', 'scope');
  const scope = latest ? parseJson(latest.scope, []) : [];
  const scoped = (Array.isArray(scope) ? scope : []).filter((f) => RESTARTABLE_FAMILIES.includes(f));
  if (scoped.length) return { families: scoped, caseId: latest.id, source: 'case_scope' };

  // Whole account ([]) or no case row: the recurring rows the processor
  // cancelled name the prior plan. Cancelled rows carry no recurring_ongoing
  // signal any more, so read the family off the row/catalog text the same
  // way the facts loader does for live rows.
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  const { CHURN_REASON } = require('../cancellation-processor');
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where('s.status', 'cancelled')
    .where('s.is_recurring', true)
    .where(function notCallback() { this.whereNull('s.is_callback').orWhere('s.is_callback', false); })
    .where('s.cancellation_reason', CHURN_REASON)
    .orderBy('s.cancelled_at', 'desc')
    .limit(50)
    .select('s.*', 'sv.service_key', 'sv.service_name');
  const keys = [];
  for (const row of rows) {
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!keys.includes(key)) keys.push(key);
  }
  const fromRows = uniqueServiceFamilies(keys).filter((f) => RESTARTABLE_FAMILIES.includes(f));
  if (fromRows.length) return { families: fromRows, caseId: latest ? latest.id : null, source: 'cancelled_rows' };

  // Last resort: the scoped-cancel audit note ("Cancelled Pest Control, Lawn
  // Care — plan continues with …") names families by label.
  const note = await dbh('customer_interactions')
    .where({ customer_id: customerId, interaction_type: 'note' })
    .where('subject', 'like', 'Cancelled %')
    .orderBy('created_at', 'desc')
    .first('subject');
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
    // Lock the customer row: a double-tap must not mint two restart estimates.
    const fresh = await trx('customers').where({ id: customer.id }).whereNull('deleted_at').forUpdate().first();
    if (!fresh) throw new RestartUnavailableError('not_cancelled', 'This account is not cancelled.');
    if (fresh.active === true || fresh.pipeline_stage !== 'churned') {
      throw new RestartUnavailableError('not_cancelled', 'This account is not cancelled.');
    }

    // Reuse a live restart estimate before pricing anything (idempotent
    // button; one honorable price at a time).
    const priorRows = await trx('estimates')
      .where({ customer_id: fresh.id, source: SOURCE })
      .whereNull('archived_at')
      .orderBy('created_at', 'desc')
      .limit(10);
    const live = liveRestartEstimate(priorRows, nowDate);
    if (live) {
      return { estimateId: live.id, token: live.token, url: `/estimate/${live.token}`, reused: true };
    }

    const { families, caseId, source } = await cancelledFamiliesFor(fresh.id, trx);
    if (!families.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'We could not find the plan to restart from this account.');
    }

    // Ownership — FAIL CLOSED like every pricing-ai consumer: a family the
    // customer somehow still holds is never re-priced beside its live rate.
    const ownership = await pricingAi.loadCurrentServiceKeys(trx, fresh);
    if (ownership.ownershipLookupFailed) {
      throw new RestartUnavailableError('pricing_unavailable', 'We could not verify your services just now. Please try again in a moment.');
    }
    const owned = new Set([...ownership.currentServiceKeys, ...ownership.ownedServiceKeys]);
    const toPrice = families.map(pricingKeyFor).filter((key) => !owned.has(key));
    if (!toPrice.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'Those services are already active on this account.');
    }

    // Property context: the same resolver the portal pricing panel uses,
    // profile-only (no external lookup spend from a restart tap).
    const turfProfile = await pricingAi.loadTurfProfile(trx, fresh.id);
    const propertyContext = await pricingAi.resolvePropertyContext({ customer: fresh, turfProfile, propertyLookup: null });
    const missing = pricingAi._private.missingPropertyFor(toPrice, propertyContext);
    if (missing) {
      throw new RestartUnavailableError('pricing_unavailable', 'We need a property measurement on file before we can price this online.');
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
        families,
        familiesSource: source,
        cancellationCaseId: caseId,
        mintedAt: nowDate.toISOString(),
      },
    };
    // priorQualifyingServices from the SERVER-derived ownership set — empty
    // for a cancelled customer, so the engine prices at today's list.
    const canonical = (key) => (key === 'termite' ? 'termite_bait' : key);
    const priorQualifyingServices = ownership.currentServiceKeys.map(canonical);
    const recomputed = await persistence.serverRecomputeFromEstimateData(estimateData, {
      priorQualifyingServices,
      recurringCustomer: priorQualifyingServices.length > 0,
    });
    if (!recomputed?.recomputed) {
      throw new Error(`plan-restart recompute failed (${recomputed?.reason || 'unknown'})`);
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
      service_interest: families.map((f) => FAMILY_LABELS[f] || f).join(' + '),
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
    try {
      await trx('customer_interactions').insert({
        customer_id: fresh.id,
        interaction_type: 'note',
        subject: `Restart estimate requested from portal — ${families.map((f) => FAMILY_LABELS[f] || f).join(', ')}`,
        body: `Customer opened a restart estimate (${created.id}) priced at today's rates. Accepting it restarts the plan.`,
      });
    } catch (noteErr) {
      logger.warn(`[plan-restart] audit note failed for ${fresh.id}: ${noteErr.message}`);
    }

    logger.info(`[plan-restart] minted estimate ${created.id} for customer ${fresh.id} (${families.join(',')} via ${source})`);
    return { estimateId: created.id, token, url: `/estimate/${token}`, reused: false };
  });
}

module.exports = {
  SOURCE,
  RESTARTABLE_FAMILIES,
  RestartUnavailableError,
  cancelledFamiliesFor,
  mintRestartEstimate,
  _test: { liveRestartEstimate },
};
