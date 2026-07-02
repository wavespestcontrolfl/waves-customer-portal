const crypto = require('crypto');
const db = require('../models/db');
const {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  normalizeEstimateDethatchingManagerApproval,
  validateEstimateDeliveryOptions,
} = require('./estimate-delivery-options');
const {
  attachLeadToEstimate,
  assertLeadCanAttachEstimate,
} = require('./lead-estimate-link');
const { clearEstimatePricingCache } = require('./estimate-pricing-cache');
const { inferEstimateServiceInterest } = require('./estimate-service-lines');
const logger = require('./logger');
const pricingEngine = require('./pricing-engine');
const { mapV1ToLegacyShape } = require('./pricing-engine/v1-legacy-mapper');
const { loadExistingQualifyingServiceKeys } = require('./waveguard-existing-services');
const { computeMembershipContext } = require('./estimate-membership-context');

function errorWithStatus(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeLinkedLeadId(leadId) {
  return typeof leadId === 'string' ? leadId.trim() : leadId;
}

function estimateViewUrl(token) {
  return `https://portal.wavespestcontrol.com/estimate/${token}`;
}

function estimateExpiresAt(now = () => new Date()) {
  // 10 days (was 7): spaces the three follow-up touches roughly one every
  // three days (day 2-3 / 5-6 / 9) instead of stacking in the back half.
  const expiresAt = new Date(now().getTime());
  expiresAt.setDate(expiresAt.getDate() + 10);
  return expiresAt;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function positiveMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : null;
}

function moneyValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundMoney(n) : null;
}

function nonNegativeMoney(value) {
  const amount = moneyValue(value);
  return amount !== null && amount >= 0 ? amount : null;
}

function fallbackMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? roundMoney(n) : 0;
}

function estimateResultRoot(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return {};
  return estimateData.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
}

function sumPositiveAmounts(rows = [], fields = ['price']) {
  return roundMoney((rows || []).reduce((sum, row) => {
    if (!row || typeof row !== 'object') return sum;
    for (const field of fields) {
      const amount = positiveMoney(row[field]);
      if (amount !== null) return sum + amount;
    }
    return sum;
  }, 0));
}

function sumSignedAmounts(rows = [], fields = ['price']) {
  return roundMoney((rows || []).reduce((sum, row) => {
    if (!row || typeof row !== 'object') return sum;
    for (const field of fields) {
      const amount = moneyValue(row[field]);
      if (amount !== null) return sum + amount;
    }
    return sum;
  }, 0));
}

function isApprovedDethatchingManagerRow(row = {}) {
  if (!row || typeof row !== 'object') return false;
  const service = String(row.service || row.key || '').toLowerCase();
  const label = String(row.name || row.label || row.displayName || '').toLowerCase();
  return (service.includes('dethatch') || label.includes('dethatch')) &&
    row.managerApproved === true &&
    row.managerApprovalSatisfied === true &&
    !!row.managerApprovalOverrideReason &&
    moneyValue(row.price) !== null;
}

function deriveTotalsFromEstimateData(estimateData) {
  const result = estimateResultRoot(estimateData);
  const recurring = result.recurring && typeof result.recurring === 'object'
    ? result.recurring
    : {};
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  const recurringRows = [
    ...(Array.isArray(recurring.services) ? recurring.services : []),
    ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
  ];
  const recurringRowsMonthly = sumPositiveAmounts(recurringRows, ['mo', 'monthly']);
  const monthlyTotal = positiveMoney(recurring.grandTotal) ??
    positiveMoney(recurring.monthlyTotal) ??
    positiveMoney(recurring.monthly) ??
    positiveMoney(nestedRecurring.grandTotal) ??
    positiveMoney(nestedRecurring.monthlyTotal) ??
    positiveMoney(result.totals?.year2mo) ??
    positiveMoney(recurringRowsMonthly);

  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const oneTimeRows = [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
  ];
  const oneTimeMembershipFee = positiveMoney(oneTime.membershipFee) ?? 0;
  const oneTimeRowsTotal = roundMoney(
    sumSignedAmounts(oneTimeRows, ['price', 'estimatedPrice', 'baseEstimatePrice']) +
    oneTimeMembershipFee
  );
  const topLevelSpecRows = Array.isArray(result.specItems)
    ? result.specItems.filter((row) => row?.onProg !== true && row?.includedOnProgram !== true)
    : [];
  const topLevelSpecRowsTotal = sumSignedAmounts(
    topLevelSpecRows,
    ['price', 'estimatedPrice', 'baseEstimatePrice']
  );
  const explicitOneTimeTotal = nonNegativeMoney(oneTime.total);
  const hasOneTimeDerivedSource = oneTimeRows.length > 0 || oneTimeMembershipFee > 0;
  const derivedOneTimeTotal = (
    hasOneTimeDerivedSource ? nonNegativeMoney(oneTimeRowsTotal) : null
  ) ?? (
    topLevelSpecRows.length > 0
      ? nonNegativeMoney(topLevelSpecRowsTotal)
      : null
  );
  const hasApprovedDethatchingManagerRow = oneTimeRows.some((row) => isApprovedDethatchingManagerRow(row));
  const oneTimeTotal = explicitOneTimeTotal !== null
    ? (
        hasApprovedDethatchingManagerRow && derivedOneTimeTotal !== null && derivedOneTimeTotal > explicitOneTimeTotal
          ? derivedOneTimeTotal
          : explicitOneTimeTotal
      )
    : derivedOneTimeTotal;

  const annualTotal = positiveMoney(result.totals?.year2) ??
    positiveMoney(recurring.annualTotal) ??
    positiveMoney(nestedRecurring.annualTotal) ??
    (monthlyTotal !== null ? roundMoney(monthlyTotal * 12) : null) ??
    positiveMoney(recurring.annualAfterDiscount) ??
    positiveMoney(nestedRecurring.annualAfterDiscount);

  return {
    monthlyTotal,
    annualTotal,
    onetimeTotal: oneTimeTotal,
  };
}

function resolveBillableTotals(body, estimateData, quoteRequired) {
  if (quoteRequired) {
    return { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 0 };
  }
  const derived = deriveTotalsFromEstimateData(estimateData);
  const monthlyTotal = derived.monthlyTotal ?? fallbackMoney(body.monthlyTotal);
  const onetimeTotal = derived.onetimeTotal ?? fallbackMoney(body.onetimeTotal);
  const annualTotal = derived.annualTotal ??
    (monthlyTotal > 0 ? roundMoney(monthlyTotal * 12) : fallbackMoney(body.annualTotal));
  return { monthlyTotal, annualTotal, onetimeTotal };
}

function applyResolvedTotalsToEstimateData(estimateData, totals, quoteRequired) {
  if (!estimateData || typeof estimateData !== 'object' || quoteRequired) return;
  const result = estimateResultRoot(estimateData);
  if (!result || typeof result !== 'object') return;

  if (result.oneTime && typeof result.oneTime === 'object' && totals.onetimeTotal > 0) {
    result.oneTime.total = totals.onetimeTotal;
    if (Object.prototype.hasOwnProperty.call(result.oneTime, 'otSubtotal')) {
      result.oneTime.otSubtotal = roundMoney(totals.onetimeTotal - fallbackMoney(result.oneTime.tmInstall));
    }
  }

  if (result.recurring && typeof result.recurring === 'object' && totals.monthlyTotal > 0) {
    result.recurring.grandTotal = totals.monthlyTotal;
    result.recurring.monthlyTotal = totals.monthlyTotal;
    if (totals.annualTotal > 0 && Object.prototype.hasOwnProperty.call(result.recurring, 'annualTotal')) {
      result.recurring.annualTotal = totals.annualTotal;
    }
  }

  if (result.totals && typeof result.totals === 'object') {
    if (totals.monthlyTotal > 0) result.totals.year2mo = totals.monthlyTotal;
    if (totals.annualTotal > 0) result.totals.year2 = totals.annualTotal;
    const year1 = roundMoney(fallbackMoney(totals.annualTotal) + fallbackMoney(totals.onetimeTotal));
    if (year1 > 0) result.totals.year1 = year1;
  }
}

// Decision #2 — the server is authoritative on the persisted/billed price.
// We replay the engine inputs the client captured back through the SAME pricing
// engine the live preview used, then persist the server-computed totals. The
// client number is retained only as an auditable preview. "Authoritative" here
// means authoritative over the COMPUTATION, conditional on the client-captured
// inputs (turf sf, services, shade, etc.) — input provenance is out of scope.
function compareClientToServer(clientTotals, serverTotals, now = () => new Date()) {
  const cA = fallbackMoney(clientTotals && clientTotals.annualTotal);
  const sA = fallbackMoney(serverTotals && serverTotals.annualTotal);
  const cM = fallbackMoney(clientTotals && clientTotals.monthlyTotal);
  const sM = fallbackMoney(serverTotals && serverTotals.monthlyTotal);
  const cO = fallbackMoney(clientTotals && clientTotals.onetimeTotal);
  const sO = fallbackMoney(serverTotals && serverTotals.onetimeTotal);
  const annualDelta = roundMoney(sA - cA);
  const monthlyDelta = roundMoney(sM - cM);
  const onetimeDelta = roundMoney(sO - cO);
  return {
    annualDelta,
    monthlyDelta,
    onetimeDelta,
    pctAnnual: cA > 0 ? Math.round((annualDelta / cA) * 10000) / 10000 : null,
    // Annual is the source of truth (the 55% lawn floor is defined on annual);
    // a few cents of monthly rounding is not drift.
    hasDrift: Math.abs(annualDelta) >= 0.5 || Math.abs(onetimeDelta) >= 0.5,
    computedAt: now().toISOString(),
  };
}

// Resolve a replayable engine input from the persisted estimate_data and re-run
// the engine. Supports both shapes: the admin save's `engineRequest`
// ({ profile, selectedServices, options } — the exact /calculate-estimate
// payload) and the public/lead `engineInputs` (already a v1 engine input).
// Returns { recomputed:true, source, serverResult, serverTotals } or
// { recomputed:false, reason } so callers can fail open.
async function serverRecomputeFromEstimateData(estimateData, deps = {}) {
  const generateEstimate = deps.generateEstimate || pricingEngine.generateEstimate;
  const needsSync = deps.needsSync || pricingEngine.needsSync;
  const syncConstantsFromDB = deps.syncConstantsFromDB || pricingEngine.syncConstantsFromDB;
  const mapResult = deps.mapV1ToLegacyShape || mapV1ToLegacyShape;
  // Lazy-require the route adapter to avoid a service→route load-order cycle.
  let translate = deps.translateV2CallToV1Input;
  if (translate === undefined) {
    try {
      translate = require('../routes/property-lookup-v2').translateV2CallToV1Input;
    } catch (_) {
      translate = null;
    }
  }

  if (!estimateData || typeof estimateData !== 'object') {
    return { recomputed: false, reason: 'NO_INPUTS' };
  }

  let v1Input = null;
  let source = null;
  const req = estimateData.engineRequest;
  if (req && typeof req === 'object' && req.profile && typeof translate === 'function') {
    try {
      v1Input = translate(req.profile, Array.isArray(req.selectedServices) ? req.selectedServices : [], req.options || {});
      source = 'ENGINE_REQUEST';
    } catch (_) {
      v1Input = null;
    }
  }
  if (!v1Input && estimateData.engineInputs && typeof estimateData.engineInputs === 'object') {
    v1Input = estimateData.engineInputs;
    source = 'ENGINE_INPUTS';
  }
  if (!v1Input) return { recomputed: false, reason: 'NO_INPUTS' };

  // Existing-customer reprice: when the estimate is linked to a customer with
  // prior qualifying recurring services, fold them into the engine input so the
  // WaveGuard tier (and thus the persisted, charged total) reflects the
  // COMBINED tier — not just the services in this one estimate.
  const priorQualifyingServices = Array.isArray(deps.priorQualifyingServices)
    ? deps.priorQualifyingServices
    : [];
  if (priorQualifyingServices.length) {
    v1Input = { ...v1Input, priorQualifyingServices };
  }

  try {
    if (typeof needsSync === 'function' && needsSync() && typeof syncConstantsFromDB === 'function') {
      await syncConstantsFromDB();
    }
    const v1 = generateEstimate(v1Input);
    const serverResult = mapResult(v1);
    const serverTotals = deriveTotalsFromEstimateData({ result: serverResult });
    return { recomputed: true, source, serverResult, serverTotals };
  } catch (error) {
    return { recomputed: false, reason: 'ENGINE_ERROR', error };
  }
}

// Decide the authoritative totals + audit columns for a save. Fails OPEN to the
// client preview (so a broken engine never blocks Virginia's save) but LOUDLY:
// every non-authoritative save is stamped CLIENT_FALLBACK (queryable column) and
// an engine error is logged at error level.
async function resolveServerAuthoritativePricing({ estimateData, clientPreview, quoteRequired, now, recompute, priorQualifyingServices }) {
  const recomputeFn = recompute || serverRecomputeFromEstimateData;
  const audit = {
    pricing_authority: null,
    server_computed_price: null,
    client_preview_price: positiveMoney(clientPreview.annualTotal),
    pricing_drift: null,
  };

  // Quote-required / manager-approval estimates carry no billable price yet —
  // leave them exactly as today (authority null, no recompute).
  if (quoteRequired) {
    return { totals: clientPreview, audit };
  }

  let result;
  try {
    result = await recomputeFn(estimateData, { now, priorQualifyingServices });
  } catch (error) {
    result = { recomputed: false, reason: 'ENGINE_ERROR', error };
  }

  if (result.recomputed) {
    // Overwrite the embedded result so the stored blob and the persisted
    // columns agree — blob/column divergence is exactly the bug class this fixes.
    estimateData.result = result.serverResult;
    const drift = compareClientToServer(clientPreview, result.serverTotals, now);
    audit.pricing_authority = 'SERVER';
    audit.server_computed_price = positiveMoney(result.serverTotals.annualTotal);
    audit.pricing_drift = drift;
    if (drift.hasDrift) {
      logger.warn(`[pricing-authority] server recompute corrected client preview annualDelta=${drift.annualDelta} pctAnnual=${drift.pctAnnual}`);
    }
    return { totals: result.serverTotals, audit };
  }

  audit.pricing_authority = 'CLIENT_FALLBACK';
  if (result.reason === 'ENGINE_ERROR') {
    // Deploy-bug signal: a billed price that came from a broken engine.
    logger.error(`[pricing-authority] CLIENT_FALLBACK reason=ENGINE_ERROR — persisted client preview as NON-authoritative price${result.error ? ` err=${result.error.message}` : ''}`);
  } else {
    // No replayable input (legacy/transitional estimate). Findable via the
    // pricing_authority column; warn rather than page.
    logger.warn(`[pricing-authority] CLIENT_FALLBACK reason=${result.reason} — no replayable engine input; persisted client preview`);
  }
  return { totals: clientPreview, audit };
}

function buildEstimatePersistenceFields(body, context = {}) {
  const estimateData = normalizeEstimateDethatchingManagerApproval(body.estimateData, context);
  const quoteRequired = estimateDataHasQuoteRequirement(estimateData) ||
    estimateDataHasUnresolvedManagerApproval(estimateData);
  const totals = resolveBillableTotals(body, estimateData, quoteRequired);
  applyResolvedTotalsToEstimateData(estimateData, totals, quoteRequired);
  const serviceInterest = inferEstimateServiceInterest({
    serviceInterest: body.serviceInterest,
    estimateData,
    monthlyTotal: totals.monthlyTotal,
    onetimeTotal: totals.onetimeTotal,
    notes: body.notes,
  });

  return {
    customer_id: body.customerId || null,
    estimate_data: estimateData ? JSON.stringify(estimateData) : null,
    address: body.address,
    customer_name: body.customerName,
    customer_phone: body.customerPhone,
    customer_email: body.customerEmail,
    monthly_total: totals.monthlyTotal,
    annual_total: totals.annualTotal,
    onetime_total: totals.onetimeTotal,
    waveguard_tier: body.waveguardTier,
    service_interest: serviceInterest,
    notes: body.notes,
    satellite_url: body.satelliteUrl,
    show_one_time_option: !!body.showOneTimeOption,
    bill_by_invoice: !!body.billByInvoice,
  };
}

async function firstForUpdate(query) {
  const lockableQuery = typeof query.forUpdate === 'function' ? query.forUpdate() : query;
  return lockableQuery.first();
}

async function createOrReuseAdminEstimate({
  database = db,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  recompute, // injectable for tests; defaults to serverRecomputeFromEstimateData
}) {
  const {
    leadId,
    showOneTimeOption,
    billByInvoice,
    estimateData,
  } = body;
  const trustedEstimateData = normalizeEstimateDethatchingManagerApproval(estimateData, {
    technician,
    technicianId,
    now,
  });
  const quoteRequired = estimateDataHasQuoteRequirement(trustedEstimateData) ||
    estimateDataHasUnresolvedManagerApproval(trustedEstimateData);
  const clientPreview = resolveBillableTotals(body, trustedEstimateData, quoteRequired);
  // For an estimate linked to an existing customer, load the WaveGuard-qualifying
  // recurring services they already have so the engine reprices at the COMBINED
  // tier. Best-effort: a failure here must not block the save, it just means the
  // estimate prices on its own services as before.
  let priorQualifyingServices = [];
  if (body.customerId) {
    try {
      priorQualifyingServices = await loadExistingQualifyingServiceKeys(database, body.customerId);
    } catch (err) {
      logger.warn(`[admin-estimate] prior qualifying services lookup skipped: ${err.message}`);
    }
  }
  const pricing = await resolveServerAuthoritativePricing({
    estimateData: trustedEstimateData,
    clientPreview,
    quoteRequired,
    now,
    recompute,
    priorQualifyingServices,
  });
  const totals = pricing.totals;
  applyResolvedTotalsToEstimateData(trustedEstimateData, totals, quoteRequired);
  // The combined-tier reprice only landed in the persisted/charged totals when
  // the server authoritatively recomputed. On CLIENT_FALLBACK (no replayable
  // engine input) the saved totals are the un-repriced client preview, so we
  // must NOT write any membership artifacts that would advertise a discount the
  // charge doesn't include.
  const repricedAtServer = pricing.audit?.pricing_authority === 'SERVER';
  // Persist the prior qualifying services into the replayable estimate data so
  // any LATER recompute from stored inputs (public bundle CTA, frequency
  // slider) keeps the combined WaveGuard tier (extractEngineInputs re-injects).
  if (repricedAtServer && priorQualifyingServices.length) {
    trustedEstimateData.priorQualifyingServices = priorQualifyingServices;
  } else {
    delete trustedEstimateData.priorQualifyingServices;
  }
  // Freeze the WaveGuard membership card onto the estimate, computed from the
  // SAME repriced data + prior services, so the customer-facing card reflects
  // exactly what was priced/charged and never re-derives from mutable service
  // rows at view time. Cleared if the estimate no longer qualifies or wasn't
  // server-repriced, and never blocks the save on error.
  let membershipSnapshot = null;
  if (repricedAtServer && body.customerId) {
    try {
      membershipSnapshot = await computeMembershipContext(database, {
        customerId: body.customerId,
        estData: trustedEstimateData,
      });
      if (membershipSnapshot) trustedEstimateData.membershipSnapshot = membershipSnapshot;
      else delete trustedEstimateData.membershipSnapshot;
    } catch (err) {
      logger.warn(`[admin-estimate] membership snapshot skipped: ${err.message}`);
      delete trustedEstimateData.membershipSnapshot;
    }
  } else {
    delete trustedEstimateData.membershipSnapshot;
  }
  // When prior services raised the combined tier, persist that authoritative
  // tier into the estimates.waveguard_tier column (the client preview may still
  // say Bronze). The public bundle + acceptance read this column for badges and
  // some tier math, so it must match the repriced estimate_data totals.
  const resolvedWaveguardTier = (repricedAtServer && priorQualifyingServices.length && membershipSnapshot?.tierLabel)
    ? membershipSnapshot.tierLabel
    : body.waveguardTier;
  const linkedLeadId = normalizeLinkedLeadId(leadId);
  const deliveryError = validateEstimateDeliveryOptions({
    showOneTimeOption: !!showOneTimeOption,
    billByInvoice: !!billByInvoice,
    onetimeTotal: totals.onetimeTotal,
    monthlyTotal: totals.monthlyTotal,
    annualTotal: totals.annualTotal,
    estimateData: trustedEstimateData,
  });
  if (deliveryError) throw errorWithStatus(deliveryError, 400);

  const expiresAt = estimateExpiresAt(now);
  const writeFields = {
    ...buildEstimatePersistenceFields(
      { ...body, waveguardTier: resolvedWaveguardTier, estimateData: trustedEstimateData },
      { technician, technicianId, now },
    ),
    ...pricing.audit,
  };

  return database.transaction(async (trx) => {
    let canReplaceLinkedEstimate = false;

    if (linkedLeadId) {
      const lead = await firstForUpdate(trx('leads').where({ id: linkedLeadId }).whereNull('deleted_at'));
      if (!lead) throw errorWithStatus('Lead not found', 404);

      if (lead.estimate_id) {
        const existingEstimate = await firstForUpdate(trx('estimates').where({ id: lead.estimate_id }));
        if (existingEstimate?.status === 'draft') {
          const nextEstimate = { ...existingEstimate, ...writeFields, expires_at: expiresAt };
          assertLeadCanAttachEstimate({
            lead,
            estimate: nextEstimate,
            estimateId: existingEstimate.id,
          });
          const [updated] = await trx('estimates')
            .where({ id: existingEstimate.id, status: 'draft' })
            .update({
              ...writeFields,
              expires_at: expiresAt,
              updated_at: now(),
            })
            .returning('*');
          if (!updated) {
            throw errorWithStatus('Estimate draft changed; refresh and try again.', 409);
          }
          clearEstimatePricingCache(existingEstimate.id);
          return {
            estimate: updated,
            reused: true,
          };
        }

        if (existingEstimate && !existingEstimate.archived_at) {
          throw errorWithStatus(
            'Lead is already linked to an active estimate. Archive or delete the existing estimate before creating a new one.',
            409,
          );
        }

        canReplaceLinkedEstimate = true;
      }
    }

    const token = randomBytes(16).toString('hex');
    const [created] = await trx('estimates').insert({
      ...writeFields,
      created_by_technician_id: technicianId,
      token,
      expires_at: expiresAt,
    }).returning('*');

    if (linkedLeadId) {
      await attachLeadToEstimate({
        database: trx,
        leadId: linkedLeadId,
        estimateId: created.id,
        estimate: created,
        technician,
        allowReplacingEstimateId: canReplaceLinkedEstimate,
      });
    }

    return {
      estimate: created,
      reused: false,
    };
  });
}

module.exports = {
  buildEstimatePersistenceFields,
  createOrReuseAdminEstimate,
  estimateExpiresAt,
  estimateViewUrl,
  serverRecomputeFromEstimateData,
  resolveServerAuthoritativePricing,
  compareClientToServer,
};
