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
  leadMatchesEstimateContact,
  normalizeContactPhone,
  normalizeContactEmail,
} = require('./lead-estimate-link');
const { clearEstimatePricingCache } = require('./estimate-pricing-cache');
const { recordPreSendRevision } = require('./estimate-learning');
const { inferEstimateServiceInterest } = require('./estimate-service-lines');
const logger = require('./logger');
const pricingEngine = require('./pricing-engine');
const { mapV1ToLegacyShape } = require('./pricing-engine/v1-legacy-mapper');
const { loadExistingQualifyingServiceKeys, isActivePlanCustomer } = require('./waveguard-existing-services');
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

// Standard send-time expiry window. Also consumed by the expiration cron
// to tell an operator EXTENSION (expires_at pushed beyond this window)
// apart from the stamp every normal send writes.
const ESTIMATE_SEND_EXPIRY_DAYS = 7;

function estimateExpiresAt(now = () => new Date()) {
  const expiresAt = new Date(now().getTime());
  expiresAt.setDate(expiresAt.getDate() + ESTIMATE_SEND_EXPIRY_DAYS);
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

// Pest post-discount program floor is SERVER-authoritative. The deprecated
// client fallback engine stamps floorPa/floorAnn/floorMo from its own
// constants.js literal ($89) AND bakes an 89-based give-back into its
// recurring totals — both ignore the DB-tuned pest_base.floor and the
// enforce_floor_post_discount kill switch. On save this normalizes the
// payload to the live synced constants:
//   1. Rows carrying CLIENT-stamped metadata (the 89-literal basis values)
//      are restamped from the live floor — or stripped when enforcement is
//      off. Rows with no metadata get stamped. Rows with OTHER values are
//      server-stamped (possibly a v2 cadence curve) and are left untouched.
//   2. When the payload is a client-engine result (it carries the
//      pestProgramFloorApplied flag), the baked 89-based lift is replaced in
//      recurring/totals by the server-correct lift, so the persisted
//      monthly_total / annual_total collect per the configured floor.
// Runs before totals resolution; a successful server recompute replaces the
// whole result afterward, making this a no-op for server-priced saves. The
// client fallback prices on the v1 cadence curve, so the restamp mirrors it.
// Manual discounts are warn-only and their computed amount is kept as-is.
const PEST_APPS_TO_FREQUENCY = { 4: 'quarterly', 6: 'bimonthly', 12: 'monthly' };
// round(89 × v1 mult) per cadence — the exact values the client literal produces.
const CLIENT_PEST_FLOOR_PA_LITERALS = new Set([89, 75.65, 62.30]);
function pestFloorLiftForAnnual(pestAnn, discountPct, floorAnn) {
  if (!(discountPct > 0) || !Number.isFinite(pestAnn) || pestAnn <= 0) return 0;
  if (!Number.isFinite(floorAnn) || floorAnn <= 0) return 0;
  const cappedFloor = Math.min(floorAnn, pestAnn);
  return Math.max(0, roundMoney(pestAnn * discountPct - (pestAnn - cappedFloor)));
}
function normalizeClientPestFloorMetadata(estimateData) {
  const root = estimateResultRoot(estimateData);
  const results = root?.results;
  if (!results || typeof results !== 'object') return;
  const pestRow = results.pest && typeof results.pest === 'object' ? results.pest : null;
  const rows = [
    ...(Array.isArray(results.pestTiers) ? results.pestTiers : []),
    ...(pestRow ? [pestRow] : []),
  ];
  if (!rows.length) return;
  const { PEST } = pricingEngine.constants;

  // Reconstruct the client-baked lift BEFORE mutating the metadata.
  const recurring = root.recurring && typeof root.recurring === 'object' ? root.recurring : null;
  const isClientEngineResult = !!recurring
    && Object.prototype.hasOwnProperty.call(recurring, 'pestProgramFloorApplied');
  const discountPct = Number(recurring?.discount) || 0;
  const pestAnn = Number(pestRow?.ann);
  const clientLift = isClientEngineResult && recurring.pestProgramFloorApplied === true
    ? pestFloorLiftForAnnual(pestAnn, discountPct, Number(pestRow?.floorAnn))
    : 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const stampedPa = Number(row.floorPa);
    const hasMetadata = Number.isFinite(stampedPa);
    const isClientStamped = hasMetadata && CLIENT_PEST_FLOOR_PA_LITERALS.has(stampedPa);
    if (hasMetadata && !isClientStamped) continue; // server-stamped — snapshot, leave alone
    // Metadata-less rows get stamped only on client-engine payloads, where the
    // totals correction below applies the matching lift. Stamping a legacy
    // no-flag payload would let the public reprice collect the floor while
    // the persisted columns keep the old discounted amount — divergence.
    if (!hasMetadata && !isClientEngineResult) continue;
    delete row.floorPa;
    delete row.floorAnn;
    delete row.floorMo;
    if (!PEST.enforceFloorPostDiscount) continue;
    const frequencyKey = PEST_APPS_TO_FREQUENCY[Number(row.apps ?? row.v)];
    if (!frequencyKey) continue;
    const freqMult = (PEST.frequencyDiscounts?.v1 || {})[frequencyKey] || 1.0;
    const floorAnn = pricingEngine.pestProgramFloorAnnual(freqMult, Number(row.apps ?? row.v));
    if (floorAnn === null) continue;
    row.floorPa = pricingEngine.pestProgramFloorPerVisit(freqMult);
    row.floorAnn = floorAnn;
    row.floorMo = Math.round((floorAnn / 12) * 100) / 100;
  }

  // Replace the client-baked lift with the server-correct one in the totals.
  if (!isClientEngineResult) return;
  const serverLift = pestFloorLiftForAnnual(pestAnn, discountPct, Number(pestRow?.floorAnn));
  const delta = roundMoney(serverLift - clientLift);
  recurring.pestProgramFloorApplied = serverLift > 0;
  if (Math.abs(delta) < 0.005) return;
  const adjust = (obj, key, d) => {
    const v = Number(obj?.[key]);
    if (Number.isFinite(v)) obj[key] = Math.max(0, roundMoney(v + d));
  };
  adjust(recurring, 'savings', -delta);
  adjust(recurring, 'annualAfterDiscount', delta);
  const newAnnualAfter = Number(recurring.annualAfterDiscount);
  if (Number.isFinite(newAnnualAfter)) {
    const oldMonthly = Number(recurring.monthlyTotal);
    const newMonthly = roundMoney(newAnnualAfter / 12);
    recurring.monthlyTotal = newMonthly;
    if (Number.isFinite(oldMonthly)) {
      adjust(recurring, 'grandTotal', roundMoney(newMonthly - oldMonthly));
    }
  }
  const totals = root.totals && typeof root.totals === 'object' ? root.totals : null;
  if (totals) {
    adjust(totals, 'year2', delta);
    const year2 = Number(totals.year2);
    if (Number.isFinite(year2) && Number.isFinite(Number(totals.year2mo))) {
      totals.year2mo = roundMoney(year2 / 12);
    }
    adjust(totals, 'year1', delta);
  }
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
// The identity/recurring fields the browser must never set on a
// SERVER-authoritative estimate: they drive the WaveGuard tier and the
// recurring-customer perk, which are earned on a verified customer_id. The
// server re-derives them; these are stripped from both the transient recompute
// input AND every stored replay shape so a later public reprice
// (extractEngineInputs) can't restore a forged value.
const CLIENT_IDENTITY_FIELDS = ['priorQualifyingServices', 'recurringCustomer', 'isRecurringCustomer'];
function sanitizeClientIdentityFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  for (const field of CLIENT_IDENTITY_FIELDS) delete obj[field];
  return obj;
}

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

  // SERVER-AUTHORITATIVE identity override. priorQualifyingServices (the
  // WaveGuard tier input) and the recurring-customer flag (the 15% one-time
  // perk) are EXISTING-CUSTOMER benefits that must be earned on a verified
  // customer_id — never claimed by the browser. The replayed estimateData
  // (engineRequest.options / engineInputs) is fully client-controlled, so on
  // this SERVER-stamped path we overwrite them from the server-derived deps
  // (loaded from body.customerId by the caller), UNCONDITIONALLY — including
  // the empty/non-member case. Without this, a forged priorQualifyingServices
  // lifted a lead's mosquito quote Bronze→Platinum, and a forged
  // recurringCustomer:true stole the one-time perk.
  const priorQualifyingServices = Array.isArray(deps.priorQualifyingServices)
    ? deps.priorQualifyingServices
    : [];
  // Strip the client-claimed identity/recurring flags, then set the
  // server-authoritative values. priorQualifyingServices is set unconditionally
  // (empty for a non-member); recurringCustomer is forced true ONLY for a
  // verified active-plan customer or one with prior qualifying services.
  // Everyone else is left to the engine's own cart-based auto-derivation
  // (activeServiceKeys), so a bundle that itself buys a recurring service still
  // legitimately earns the perk while a one-time-only lead cannot forge it.
  v1Input = sanitizeClientIdentityFields({ ...v1Input });
  v1Input.priorQualifyingServices = priorQualifyingServices;
  if (deps.recurringCustomer === true || priorQualifyingServices.length > 0) {
    v1Input.recurringCustomer = true;
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
async function resolveServerAuthoritativePricing({ estimateData, clientPreview, quoteRequired, now, recompute, priorQualifyingServices, recurringCustomer }) {
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
    result = await recomputeFn(estimateData, { now, priorQualifyingServices, recurringCustomer });
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

  // Stamp the engine version that actually priced this estimate (varchar(80)
  // since migration 20260713000020 — lawn mechanism tokens like
  // LAWN_PRICING_V2_DENSE_35_FLOOR don't fit the original 10. Gated on the
  // resolved pricing authority, NOT just the blob: on CLIENT_FALLBACK the
  // blob is still the caller-supplied payload and may carry a stale
  // engineVersion from an earlier server price — a row the server did not
  // recompute must keep the column default rather than claim a version.
  const pricingVersion = context.pricingAuthority === 'SERVER'
    && typeof estimateData?.result?.engineVersion === 'string'
    ? estimateData.result.engineVersion.slice(0, 80)
    : null;

  return {
    // Always emitted: a non-SERVER rewrite RESETS the column to its migration
    // default, so a draft first stamped by a server price can't keep claiming
    // that version after a CLIENT_FALLBACK/quote-required rewrite replaced
    // its estimate_data (updates spread these fields over the existing row).
    pricing_version: pricingVersion || 'v4.2',
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

function parseStoredEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try {
      return JSON.parse(estimateData);
    } catch {
      return null;
    }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

// The full save-time pricing pipeline shared by create and revise: trust-strip
// the client payload, normalize the pest floor metadata, recompute the
// server-authoritative price, freeze membership artifacts, and validate the
// delivery options. Returns the estimates-table write fields (everything
// except the identity/lifecycle columns the caller owns: id, token, status,
// expires_at, created_by_technician_id).
async function resolveEstimateWritePayload({
  database = db,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  recompute, // injectable for tests; defaults to serverRecomputeFromEstimateData
}) {
  const {
    showOneTimeOption,
    billByInvoice,
    estimateData,
  } = body;
  const trustedEstimateData = normalizeEstimateDethatchingManagerApproval(estimateData, {
    technician,
    technicianId,
    now,
  });
  // Server-authoritative pest program floor: normalize client-stamped floor
  // metadata AND the client-baked lift in the totals BEFORE resolving the
  // billable preview, so CLIENT_FALLBACK persists collect per the live
  // DB-synced floor/kill switch. Sync the pricing constants first —
  // serverRecomputeFromEstimateData returns NO_INPUTS before any sync on
  // fallback payloads, so without this the restamp could use a stale
  // in-memory floor right after a pricing_config edit. Best-effort: a sync
  // failure must not block the save (the restamp then uses the last-synced
  // constants, same as every other pricing surface).
  try {
    if (pricingEngine.needsSync && pricingEngine.needsSync()) {
      await pricingEngine.syncConstantsFromDB(database);
    }
  } catch (err) {
    logger.warn(`[admin-estimate] pricing-config sync before floor normalize skipped: ${err.message}`);
  }
  normalizeClientPestFloorMetadata(trustedEstimateData);
  const quoteRequired = estimateDataHasQuoteRequirement(trustedEstimateData) ||
    estimateDataHasUnresolvedManagerApproval(trustedEstimateData);
  const clientPreview = resolveBillableTotals(body, trustedEstimateData, quoteRequired);
  // For an estimate linked to an existing customer, load the WaveGuard-qualifying
  // recurring services they already have so the engine reprices at the COMBINED
  // tier. Best-effort: a failure here must not block the save, it just means the
  // estimate prices on its own services as before.
  let priorQualifyingServices = [];
  // Server-verified recurring-customer status (gates the 15% one-time perk).
  // Fail-closed to false: a lookup miss/error charges as a non-member, never
  // silently grants the perk — same posture as isActivePlanCustomer itself.
  let recurringCustomer = false;
  if (body.customerId) {
    try {
      priorQualifyingServices = await loadExistingQualifyingServiceKeys(database, body.customerId);
    } catch (err) {
      logger.warn(`[admin-estimate] prior qualifying services lookup skipped: ${err.message}`);
    }
    try {
      recurringCustomer = await isActivePlanCustomer(database, body.customerId);
    } catch (err) {
      logger.warn(`[admin-estimate] active-plan lookup skipped: ${err.message}`);
    }
  }
  const pricing = await resolveServerAuthoritativePricing({
    estimateData: trustedEstimateData,
    clientPreview,
    quoteRequired,
    now,
    recompute,
    priorQualifyingServices,
    recurringCustomer,
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
  // Strip the client-claimed identity/recurring flags from every STORED replay
  // shape (engineInputs + engineRequest.options). extractEngineInputs replays
  // from engineInputs on the public reprice, so a forged
  // priorQualifyingServices / recurringCustomer left in the stored blob would
  // otherwise be restored at accept/charge time even though the initial save
  // is stamped SERVER. The authoritative combined-tier value lives in the
  // top-level trustedEstimateData.priorQualifyingServices set above (which
  // extractEngineInputs re-injects); recurring status re-derives from those
  // priors + the cart on replay — so a non-member cannot restore a forged one.
  sanitizeClientIdentityFields(trustedEstimateData.engineInputs);
  sanitizeClientIdentityFields(trustedEstimateData.inputs);
  if (trustedEstimateData.engineRequest && typeof trustedEstimateData.engineRequest === 'object') {
    sanitizeClientIdentityFields(trustedEstimateData.engineRequest.options);
  }
  // Persist the SERVER-verified recurring-customer status into the stored
  // engineInputs so a public reprice reapplies the perk a verified active-plan
  // member earned at save — even when they hold NO WaveGuard-qualifying prior
  // services (so priorQualifyingServices is empty and can't carry it, and the
  // cart alone wouldn't re-derive it). Written AFTER the sanitize so it is the
  // server value, never a replayed client claim; only for a verified member,
  // so a non-member's replay still can't gain the perk.
  if (repricedAtServer && recurringCustomer) {
    if (trustedEstimateData.engineInputs && typeof trustedEstimateData.engineInputs === 'object') {
      trustedEstimateData.engineInputs.recurringCustomer = true;
    }
    if (trustedEstimateData.inputs && typeof trustedEstimateData.inputs === 'object') {
      trustedEstimateData.inputs.recurringCustomer = true;
    }
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
  const deliveryError = validateEstimateDeliveryOptions({
    showOneTimeOption: !!showOneTimeOption,
    billByInvoice: !!billByInvoice,
    onetimeTotal: totals.onetimeTotal,
    monthlyTotal: totals.monthlyTotal,
    annualTotal: totals.annualTotal,
    estimateData: trustedEstimateData,
  });
  if (deliveryError) throw errorWithStatus(deliveryError, 400);

  return {
    ...buildEstimatePersistenceFields(
      { ...body, waveguardTier: resolvedWaveguardTier, estimateData: trustedEstimateData },
      { technician, technicianId, now, pricingAuthority: pricing.audit?.pricing_authority },
    ),
    ...pricing.audit,
  };
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
  const linkedLeadId = normalizeLinkedLeadId(body.leadId);
  const writeFields = await resolveEstimateWritePayload({
    database,
    body,
    technicianId,
    technician,
    now,
    recompute,
  });
  const expiresAt = estimateExpiresAt(now);

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
          // The builder just wholesale-replaced whatever composition this
          // linked draft held, and `source` is not part of the write payload
          // so an AI draft stays an AI draft. Capture the locked pre-edit
          // row: an operator discarding the AI composition entirely is a
          // maximal edit, not a sent-unedited (same contract as
          // reviseAdminEstimate — see estimate-learning.js).
          await recordPreSendRevision({ priorEstimate: existingEstimate, trx });
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

// Statuses a revise can never touch. Acceptance locks the price and spins up
// downstream records; declined/expired are closed; `sending` means a send is
// mid-flight (editing under it would race the sender's pre-send read into a
// stale-content send). draft / scheduled / sent / viewed / send_failed remain
// editable — the whole point is fixing a quote the customer already has.
const REVISE_BLOCKED_STATUSES = ['accepted', 'declined', 'expired', 'sending'];

// Single source of truth for "can this estimate be edited in place?" —
// consumed by the revise write below and by GET /:id/edit-source so the
// builder can explain a non-editable row instead of failing on save.
// Returns null when editable, otherwise { message, statusCode }.
function estimateReviseBlock(estimate, estimateData, now = new Date()) {
  const parsed = estimateData === undefined
    ? parseStoredEstimateData(estimate?.estimate_data)
    : estimateData;
  if (estimate?.archived_at) {
    return { message: 'Estimate is archived. Unarchive it before editing.', statusCode: 400 };
  }
  if (parsed?.proposal?.enabled === true) {
    return { message: 'This estimate is a commercial proposal — edit it with the Commercial proposal editor.', statusCode: 400 };
  }
  if (estimate?.price_locked_at) {
    return { message: 'This estimate is price-locked (accepted) and can no longer be edited.', statusCode: 409 };
  }
  const status = String(estimate?.status || '');
  if (status === 'sending') {
    return { message: 'This estimate is being sent right now. Wait for the send to finish, then retry.', statusCode: 409 };
  }
  if (REVISE_BLOCKED_STATUSES.includes(status)) {
    return { message: `A ${status} estimate can no longer be edited.`, statusCode: 409 };
  }
  // Date-expired rows the daily expiration worker hasn't flipped yet are
  // expired all the same: the public route serves the expired page off the
  // timestamp, so a revise would report saved while the customer's link keeps
  // showing nothing new. Same verdict as status='expired'.
  const expiresAt = estimate?.expires_at ? new Date(estimate.expires_at) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now) {
    return { message: 'This estimate has passed its expiration date and can no longer be edited. Extend it first, then edit.', statusCode: 409 };
  }
  return null;
}

// Row-level keys that live INSIDE estimate_data but are linkage, not quote
// content: the lead_id mirror (lead rows with no leads.estimate_id FK rely on
// it for send/view/acceptance advancement) and the schedule-stitch pointer
// the pipeline list + booking flows resolve appointments through. A revise
// replaces estimate_data wholesale, so these must be carried across.
const REVISE_PRESERVED_ESTIMATE_DATA_KEYS = ['lead_id', 'scheduled_service_id'];

// Revise an existing estimate in place: same body + pricing pipeline as
// create, but the row keeps its id, token, status, expiry, creator, and
// lead/customer linkage — so the link the customer already received simply
// starts showing the updated quote. A later send/resend re-stamps the send
// snapshot and expiry exactly like a first send.
async function reviseAdminEstimate({
  database = db,
  estimateId,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  recompute, // injectable for tests; defaults to serverRecomputeFromEstimateData
  // Run every guard and the full pricing pipeline but skip the write — the
  // builder preflights an edit-mode save with this so the operator confirms a
  // server-repriced total BEFORE it publishes to the customer's live link.
  dryRun = false,
}) {
  const estimate = await database('estimates').where({ id: estimateId }).first();
  if (!estimate) throw errorWithStatus('Estimate not found', 404);
  const block = estimateReviseBlock(estimate, undefined, now());
  if (block) throw errorWithStatus(block.message, block.statusCode);
  // A revise is a full quote rewrite — without a payload it would null the
  // stored blob (and silently orphan the linkage keys preserved below).
  if (!body?.estimateData || typeof body.estimateData !== 'object') {
    throw errorWithStatus('estimateData is required to revise an estimate.', 400);
  }
  // An in-place revision can never move the row to another account: the token
  // already in the customer's hands would become a bearer link into someone
  // else's quote and acceptance. A different explicit customerId (customer
  // lookup picking another match in the builder) is a new-estimate job.
  if (estimate.customer_id && body.customerId
      && String(body.customerId) !== String(estimate.customer_id)) {
    throw errorWithStatus(
      'This estimate is linked to a customer and an in-place edit cannot move it to a different customer. Create a new estimate for the other customer.',
      409,
    );
  }
  const existingData = parseStoredEstimateData(estimate.estimate_data) || {};

  // The satellite snapshot describes a PROPERTY, not the quote: it may only
  // survive the revise while the address still matches. An address edit made
  // without a fresh property lookup sends no replacement, and falling back to
  // the row would pin the previous property's image to the revised quote.
  const addressKey = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const sameAddress = addressKey(body.address) === addressKey(estimate.address);

  // The builder may reopen an estimate whose contact/customer linkage it did
  // not capture (auto-send or agent-drafted rows) — never let a blank field in
  // the edit payload sever the row's existing linkage or satellite snapshot.
  const writeFields = await resolveEstimateWritePayload({
    database,
    body: {
      ...body,
      customerId: body.customerId || estimate.customer_id || null,
      satelliteUrl: body.satelliteUrl || (sameAddress ? estimate.satellite_url : null) || null,
    },
    technicianId,
    technician,
    now,
    recompute,
  });

  // Carry the linkage keys across the wholesale estimate_data rewrite.
  if (writeFields.estimate_data) {
    let nextData = null;
    try {
      nextData = JSON.parse(writeFields.estimate_data);
    } catch {
      nextData = null;
    }
    if (nextData && typeof nextData === 'object') {
      let preserved = false;
      for (const key of REVISE_PRESERVED_ESTIMATE_DATA_KEYS) {
        if (existingData[key] !== undefined && nextData[key] === undefined) {
          nextData[key] = existingData[key];
          preserved = true;
        }
      }
      if (preserved) writeFields.estimate_data = JSON.stringify(nextData);
    }
  }

  // Lead-contact revalidation: the lead send/view/acceptance flows treat the
  // linkage (leads.estimate_id FK, or the estimate_data.lead_id mirror) as
  // authoritative and would advance/convert the ORIGINAL lead on the revised
  // estimate's events. If the revise moves the estimate to a different
  // contact, refuse — the operator should fix the lead or quote the other
  // customer on a new estimate. Same contact-match rule as lead attach
  // (normalized phone/email, so a pure reformat still passes). Gated on an
  // actual contact change so a service-only edit on a row whose linkage was
  // already imperfect never gets bricked by this check.
  const contactChanged =
    String(writeFields.customer_id ?? '') !== String(estimate.customer_id ?? '') ||
    String(writeFields.customer_phone ?? '') !== String(estimate.customer_phone ?? '') ||
    String(writeFields.customer_email ?? '') !== String(estimate.customer_email ?? '');
  if (contactChanged) {
    let linkedLead = await database('leads')
      .where({ estimate_id: estimate.id })
      .whereNull('deleted_at')
      .first();
    if (!linkedLead && existingData.lead_id) {
      linkedLead = await database('leads')
        .where({ id: existingData.lead_id })
        .whereNull('deleted_at')
        .first();
    }
    if (linkedLead && !leadMatchesEstimateContact(linkedLead, { ...estimate, ...writeFields })) {
      throw errorWithStatus(
        'This estimate is linked to a lead whose contact does not match the revised customer. Update the lead first, or create a new estimate for the other customer.',
        409,
      );
    }

    // Customer-linkage revalidation, same idea as the lead guard: public
    // acceptance converts/schedules/invoices against estimate.customer_id
    // (estimate-public accept flow), so a revise that moves the contact while
    // the preserve above keeps the link would show one contact's quote and
    // commit the accepted work to the previous customer's account. Match with
    // the same normalized phone/email rule the lead guard uses; a preserved
    // id pointing at a missing customer row fails the same way.
    if (writeFields.customer_id) {
      const linkedCustomer = await database('customers')
        .where({ id: writeFields.customer_id })
        .first();
      const revised = { ...estimate, ...writeFields };
      const customerPhone = normalizeContactPhone(linkedCustomer?.phone);
      const revisedPhone = normalizeContactPhone(revised.customer_phone);
      const customerEmail = normalizeContactEmail(linkedCustomer?.email);
      const revisedEmail = normalizeContactEmail(revised.customer_email);
      const matchesCustomer = !!linkedCustomer && (
        (customerPhone && revisedPhone && customerPhone === revisedPhone)
        || (customerEmail && revisedEmail && customerEmail === revisedEmail)
      );
      if (!matchesCustomer) {
        throw errorWithStatus(
          'This estimate is linked to a customer whose contact does not match the revised contact. Update the customer record first, or create a new estimate for the other customer.',
          409,
        );
      }
    }

    // Token-only rows (no lead, no ORIGINAL customer link — attaching one in
    // this same revise doesn't count, that's how an audience swap would dress
    // itself up) have nothing to revalidate against, but the same-audience
    // rule still holds: once the quote is delivered, the token in the
    // recipient's hands is a bearer link, and a contact move would point it
    // at another person's quote. Normalized compare so a pure reformat of
    // the same phone/email still saves.
    const delivered = !!(estimate.sent_at || estimate.viewed_at);
    if (delivered && !linkedLead && !estimate.customer_id) {
      const phoneMoved = normalizeContactPhone(writeFields.customer_phone)
        !== normalizeContactPhone(estimate.customer_phone);
      const emailMoved = normalizeContactEmail(writeFields.customer_email)
        !== normalizeContactEmail(estimate.customer_email);
      if (phoneMoved || emailMoved) {
        throw errorWithStatus(
          'This estimate was already sent and has no linked customer or lead to validate a contact change against. Create a new estimate for the other contact.',
          409,
        );
      }
    }
  }

  // Preflight stops here: same guards, same pricing pipeline, no write — the
  // returned totals let the builder confirm a server reprice with the
  // operator before anything reaches the customer's live link.
  if (dryRun) {
    return { estimate: { ...estimate, ...writeFields }, dryRun: true };
  }

  // Atomic revise guard: the editability check above ran on a pre-read, so
  // scope the UPDATE to the same editable conditions — a customer accept or
  // an in-flight send landing between SELECT and UPDATE must win, not be
  // silently overwritten. The category predicate closes the proposal race:
  // PUT /:id/proposal is the only writer that turns a row into a commercial
  // proposal and it always stamps category='COMMERCIAL' in the same UPDATE,
  // so a conversion landing after our pre-read can't be clobbered either.
  // Replacing estimate_data wholesale also drops the prior send's pricing
  // snapshot and any customer-picked preferences, which is intended: they
  // described the PREVIOUS quote (the public view falls back to live pricing
  // until the next send re-stamps a snapshot).
  const updated = await database.transaction(async (trx) => {
    // Re-read the row under its lock before rewriting: the pre-read
    // `estimate` above goes stale during payload resolution, and an Agent
    // Estimate recomposition landing in that gap replaces the composition
    // and resets its baseline. The baseline must snapshot the composition
    // this UPDATE actually replaces, so the locked row — not the pre-read —
    // feeds the capture below.
    const lockedPrior = await trx('estimates')
      .where({ id: estimate.id })
      .forUpdate()
      .first();
    if (!lockedPrior) return null;
    const [row] = await trx('estimates')
      .where({ id: estimate.id })
      .whereNull('price_locked_at')
      .whereNull('archived_at')
      .whereNotIn('status', REVISE_BLOCKED_STATUSES)
      .whereRaw("COALESCE(category, '') <> 'COMMERCIAL'")
      // Mirrors the pre-read's date-expiry verdict: the payload resolution
      // above (pricing recompute, DB lookups) leaves a window in which the
      // row can pass its expires_at, and a commit after that would report
      // saved while the public link already serves the expired page.
      .where((qb) => qb.whereNull('expires_at').orWhere('expires_at', '>', now()))
      .update({
        ...writeFields,
        updated_at: now(),
      })
      .returning('*');
    if (!row) return null;
    // Learning-loop capture rides the same transaction as the rewrite: the
    // locked pre-edit row is the AI composition this wholesale rewrite
    // replaces, and committing the new composition before its baseline
    // exists would let a concurrent send read the draft as "unedited" (see
    // estimate-learning.js for the concurrency contract).
    await recordPreSendRevision({ priorEstimate: lockedPrior, trx });
    return row;
  });
  if (!updated) {
    throw errorWithStatus('Estimate was accepted, locked, converted, or expired while you were editing. Refresh and retry.', 409);
  }
  clearEstimatePricingCache(estimate.id);
  return { estimate: updated };
}

module.exports = {
  buildEstimatePersistenceFields,
  createOrReuseAdminEstimate,
  estimateExpiresAt,
  ESTIMATE_SEND_EXPIRY_DAYS,
  estimateViewUrl,
  estimateReviseBlock,
  normalizeClientPestFloorMetadata,
  reviseAdminEstimate,
  serverRecomputeFromEstimateData,
  resolveServerAuthoritativePricing,
  compareClientToServer,
  sanitizeClientIdentityFields,
};
