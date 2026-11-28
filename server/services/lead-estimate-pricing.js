/**
 * Customer-facing estimate pricing & SMS dispatch price verification for the
 * Lead Response Agent.
 *
 * Mirrors payment-status-contract.js's verbatim-sentence contract:
 *  - Only open, delivered, viewable, authority-approved estimates uniquely bound
 *    to the assigned lead expose server-rendered `priceSentences`.
 *  - Every outgoing lead SMS is verified at both pre-flight and locked send-time:
 *    verified verbatim sentences from this lead's current estimate are stripped,
 *    and any remaining currency/price/unit wording fails closed to staff review.
 */

const logger = require('./logger');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
const { isUndeliveredSelfServe } = require('./self-serve-estimates');
const { isCommercialAutoAcceptEstimate } = require('./estimate-commercial-identity');
const { estimateDataHasQuoteRequirement } = require('./estimate-delivery-options');
const { perApplicationAverageFor } = require('./estimate-monthly-average');
const {
  estimateBillsPerApplication,
  estimateSoldAsAnnualPrepay,
  estimateIsPriceLocked,
  resolveLivePricing,
} = require('./estimate-proposal-billing');
const { normalizeGsmPunctuation } = require('./messaging/gsm-normalize');

const VIEWABLE_LIMIT = 5;
const VIEWABLE_PAGE = 15;
const OPEN_QUOTABLE_STATUSES = new Set(['sent', 'viewed']);

// Any price, currency, or billing-unit signal left OUTSIDE a server-rendered
// verbatim sentence fails closed.
const UNVERIFIED_PRICE_SIGNAL_RE = /\$\s*\d|\$|\busd\b|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?|bucks|cents|\/\s*(?:mo(?:nth)?|yr|year|app(?:lication)?|visit|tx|treatment)|per\s+(?:month|mo|year|yr|application|app|visit|treatment|service)|a\s+(?:month|year|application|visit)|one[\s-]time)\b|\b(?:per\s+(?:application|month|visit|year|treatment|service)|\/\s*(?:mo|month|yr|year|app|visit))\b|\b(?:costs?|price[ds]?|quoted?|rate|fee|charge[ds]?|total)\b[^.!?\n]*\d/i;

function positiveMoneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
}

function formatDollarsFromCents(cents) {
  const whole = Math.floor(cents / 100);
  const rem = cents % 100;
  return rem === 0
    ? `$${whole.toLocaleString('en-US')}`
    : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cleanEstimateLineLabel(label) {
  return String(label || '')
    .replace(/\s+[\u2014\u2013-]\s+\d{1,2}\s+applications?\/yr\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strict parser: malformed JSON fails closed so an unreadable estimate_data
// blob can never strip call-side/lead metadata and bypass visibility guards.
function parseEstimateDataStrict(raw) {
  if (raw === null || raw === undefined) return { ok: true, data: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, data: raw };
  if (typeof raw !== 'string') return { ok: false, data: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null) return { ok: true, data: {} };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, data: null };
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, data: null };
  }
}

function estimateRecordedLeadId(estimate, data) {
  return estimate?.lead_id || data?.lead_id || data?.leadId || data?.estimatorEngine?.leadId || null;
}

function estimateIsQuoteRequired(estimate, data) {
  if (String(estimate?.status || '').toLowerCase() === 'quote_required') return true;
  if (estimate?.quote_required === true || data?.quoteRequired === true) return true;
  try {
    return estimateDataHasQuoteRequirement(data) === true;
  } catch {
    return false;
  }
}

function estimateLinkOnlyReason(estimate, data) {
  if (estimateIsQuoteRequired(estimate, data)) return 'quote_required';
  const status = String(estimate?.status || '').toLowerCase();
  if (!OPEN_QUOTABLE_STATUSES.has(status) || estimateIsPriceLocked(estimate)) return 'estimate_closed';
  if (String(estimate?.category || '').toUpperCase() === 'COMMERCIAL'
    || isCommercialAutoAcceptEstimate(estimate)
    || data?.proposal?.enabled === true) {
    return 'use_estimate_link';
  }
  return null;
}

function isPerApplicationOneTimeItem(item) {
  return item?.priceUnit === 'application'
    || typeof item?.addOnKey === 'string'
    || item?.service === 'area_addon';
}

function classifyOneTimeBreakdownItems(items, data) {
  const rows = Array.isArray(items) ? items : [];
  const charges = rows.filter((item) => item
    && item.kind !== 'credit'
    && item.kind !== 'discount'
    && positiveMoneyCents(item.amount ?? item.price) !== null);
  if (charges.length > 0) {
    const perAppCount = charges.filter(isPerApplicationOneTimeItem).length;
    if (perAppCount === charges.length) return { unitKind: 'per_application', charges };
    return { unitKind: perAppCount > 0 ? 'mixed' : 'one_time', charges };
  }
  const fallbackRows = [
    ...(Array.isArray(data?.oneTimeBreakdown?.items) ? data.oneTimeBreakdown.items : []),
    ...(Array.isArray(data?.pricingEngineResult?.lineItems) ? data.pricingEngineResult.lineItems : []),
    ...(Array.isArray(data?.lineItems) ? data.lineItems : []),
  ];
  return { unitKind: fallbackRows.some(isPerApplicationOneTimeItem) ? 'mixed' : 'one_time', charges: [] };
}

function singleOneTimeLabel(charges, estimate) {
  // Withhold multi-item bundles so a bundle total cannot be quoted as a single
  // component; only a single named service produces a verbatim sentence.
  if (charges.length > 1) return '';
  if (charges.length === 1) {
    const item = charges[0];
    return cleanEstimateLineLabel(
      item?.label || item?.name || item?.addOnKey || (item?.service !== 'area_addon' ? item?.service : ''),
    );
  }
  return cleanEstimateLineLabel(estimate?.service_interest);
}

function bundleHasRecurringPricing(bundle) {
  const freqs = Array.isArray(bundle?.frequencies) ? bundle.frequencies : [];
  return freqs.some((freq) => [
    freq?.monthly,
    freq?.annual,
    freq?.monthlyRate,
    freq?.monthlyTotal,
    freq?.annualTotal,
    freq?.perApplication,
  ].some((val) => positiveMoneyCents(val) !== null));
}

async function resolveLiveOneTimeBundle(estimate) {
  const live = await resolveLivePricing(structuredClone(estimate), { rethrow: true });
  if (!live || live.unresolved || !live.bundle) return { reason: 'use_estimate_link' };
  if (live.bundle.quoteRequired === true) return { reason: 'quote_required' };
  if (live.bundle.defaultServiceMode && live.bundle.defaultServiceMode !== 'one_time') {
    return { reason: 'use_estimate_link' };
  }
  if (bundleHasRecurringPricing(live.bundle)) return { reason: 'use_estimate_link' };
  const cents = positiveMoneyCents(
    live.bundle.anchorOneTimePrice ?? live.bundle.oneTimeBreakdown?.total ?? live.bundle.oneTimeTotal,
  );
  if (!cents) return { reason: 'use_estimate_link' };
  return { cents, items: live.bundle.oneTimeBreakdown?.items || null };
}

async function perApplicationEstimatePricing(estimate) {
  const average = await perApplicationAverageFor(estimate, { rethrow: true });
  if (!average?.model?.services?.length || average.model.credit) return null;
  const lines = [];
  const priceSentences = [];
  for (const service of average.model.services) {
    const cents = positiveMoneyCents(service.perApplication);
    const applicationsPerYear = Math.round(Number(service.visits));
    const label = cleanEstimateLineLabel(service.label);
    if (!cents || !(applicationsPerYear > 0) || !label) return null;
    const amountText = formatDollarsFromCents(cents);
    const appWord = applicationsPerYear === 1 ? 'application' : 'applications';
    const sentence = `Your estimate lists ${label} at ${amountText} per application, ${applicationsPerYear} ${appWord} a year.`;
    lines.push({
      label,
      amount: cents / 100,
      unit: 'per_application',
      applicationsPerYear,
      display: `${amountText} per application (${applicationsPerYear} ${appWord}/yr)`,
    });
    priceSentences.push(sentence);
  }
  const oneTime = average.inputs?.oneTime;
  if (oneTime && positiveMoneyCents(oneTime.amount) !== null && oneTime.setup !== true) return null;
  const oneTimeCents = oneTime?.setup === true ? positiveMoneyCents(oneTime.amount) : null;
  const oneTimeCharge = oneTimeCents ? {
    amount: oneTimeCents / 100,
    unit: 'one_time',
    label: 'one-time setup fee',
    display: `${formatDollarsFromCents(oneTimeCents)} one-time setup fee`,
  } : null;
  if (oneTimeCharge) {
    priceSentences.push(`Your estimate lists a one-time setup fee of ${formatDollarsFromCents(oneTimeCents)}.`);
  }
  return {
    pricing: {
      unit: 'per_application',
      lines,
      ...(oneTimeCharge ? { oneTimeCharge } : {}),
      priceSentences,
      display: priceSentences.join(' '),
    },
  };
}

async function oneTimeEstimatePricing(estimate, data) {
  const resolved = await resolveLiveOneTimeBundle(estimate);
  if (resolved.reason) return { pricingUnavailable: resolved.reason };
  const breakdownItems = resolved.items
    || data?.sendSnapshot?.pricingBundle?.oneTimeBreakdown?.items
    || data?.oneTimeBreakdown?.items
    || null;
  const { unitKind, charges } = classifyOneTimeBreakdownItems(breakdownItems, data);
  if (unitKind === 'mixed') return { pricingUnavailable: 'use_estimate_link' };
  const label = singleOneTimeLabel(charges, estimate);
  if (!label) return { pricingUnavailable: 'use_estimate_link' };
  const suffix = unitKind === 'per_application' ? 'per application' : 'one-time';
  const sentence = `Your estimate lists ${label} at ${formatDollarsFromCents(resolved.cents)} ${suffix}.`;
  return {
    pricing: {
      unit: unitKind,
      amount: resolved.cents / 100,
      serviceLabel: label,
      priceSentences: [sentence],
      display: sentence,
    },
  };
}

async function monthlyMembershipEstimatePricing(estimate, monthlyCents) {
  const [perApplication, prepaid] = await Promise.all([
    estimateBillsPerApplication(estimate, { rethrow: true }),
    estimateSoldAsAnnualPrepay(estimate, { rethrow: true }),
  ]);
  if (perApplication !== false || prepaid !== false) return { pricingUnavailable: 'use_estimate_link' };
  const live = await resolveLivePricing(structuredClone(estimate), { rethrow: true });
  if (!live || live.unresolved || !live.bundle) return { pricingUnavailable: 'use_estimate_link' };
  if (live.bundle.quoteRequired === true) return { pricingUnavailable: 'quote_required' };
  if (live.snapshotHit !== true) return { pricingUnavailable: 'use_estimate_link' };
  const hasExtraFees = positiveMoneyCents(live.bundle.setupFee?.amount) !== null
    || (Array.isArray(live.bundle.firstVisitFees) && live.bundle.firstVisitFees.some((f) => positiveMoneyCents(f?.amount) !== null));
  if (hasExtraFees) return { pricingUnavailable: 'use_estimate_link' };
  const label = cleanEstimateLineLabel(estimate?.service_interest);
  if (!label) return { pricingUnavailable: 'use_estimate_link' };
  const sentence = `Your estimate lists ${label} at ${formatDollarsFromCents(monthlyCents)} per month.`;
  return {
    pricing: {
      unit: 'per_month',
      amount: monthlyCents / 100,
      serviceLabel: label,
      priceSentences: [sentence],
      display: sentence,
    },
  };
}

// Conflict check runs BEFORE accepting any match, including an explicit
// lead.estimate_id, so a stale link can never override conflicting lead or
// property identifiers.
function rowIdentifierConflict(entry, lead) {
  const rec = estimateRecordedLeadId(entry.row, entry.data);
  if (rec && lead?.id && String(rec) !== String(lead.id)) return 'different_lead_estimate';
  if (lead?.property_id && entry.row?.property_id && String(lead.property_id) !== String(entry.row.property_id)) {
    return 'different_property_estimate';
  }
  return null;
}

function resolveLeadBindingPlan(allEligible, lead) {
  if (lead?.estimate_id) {
    const linked = allEligible.find((e) => String(e.row.id) === String(lead.estimate_id));
    if (!linked) return { boundId: null, fallbackReason: 'different_lead_estimate' };
    const conflict = rowIdentifierConflict(linked, lead);
    return conflict ? { boundId: null, fallbackReason: conflict } : { boundId: String(linked.row.id), fallbackReason: 'different_lead_estimate' };
  }
  const nonConflicting = allEligible.filter((e) => !rowIdentifierConflict(e, lead));
  if (lead?.id) {
    const leadMatches = nonConflicting.filter((e) => {
      const rec = estimateRecordedLeadId(e.row, e.data);
      return rec && String(rec) === String(lead.id);
    });
    if (leadMatches.length === 1) return { boundId: String(leadMatches[0].row.id), fallbackReason: 'different_lead_estimate' };
    if (leadMatches.length > 1) return { boundId: null, fallbackReason: 'ambiguous_multiple_estimates' };
  }
  if (lead?.property_id) {
    const propMatches = nonConflicting.filter((e) => e.row?.property_id && String(e.row.property_id) === String(lead.property_id));
    if (propMatches.length === 1) return { boundId: String(propMatches[0].row.id), fallbackReason: 'different_property_estimate' };
    return { boundId: null, fallbackReason: propMatches.length > 1 ? 'ambiguous_multiple_estimates' : 'different_property_estimate' };
  }
  if (nonConflicting.length === 1 && allEligible.length === 1) {
    return { boundId: String(nonConflicting[0].row.id), fallbackReason: null };
  }
  return { boundId: null, fallbackReason: allEligible.length === 1 ? 'different_lead_estimate' : 'ambiguous_multiple_estimates' };
}

function bindingReasonForRow(entry, lead, plan) {
  const conflict = rowIdentifierConflict(entry, lead);
  if (conflict) return conflict;
  if (plan.boundId && String(entry.row.id) === plan.boundId) return null;
  return plan.fallbackReason || 'ambiguous_multiple_estimates';
}

async function customerFacingEstimatePricing(estimate, data) {
  const linkOnlyReason = estimateLinkOnlyReason(estimate, data);
  if (linkOnlyReason) return { pricingUnavailable: linkOnlyReason };
  try {
    const perApp = await perApplicationEstimatePricing(estimate);
    if (perApp) return perApp;
    const monthlyCents = positiveMoneyCents(estimate?.monthly_total);
    const annualCents = positiveMoneyCents(estimate?.annual_total);
    const onetimeCents = positiveMoneyCents(estimate?.onetime_total);
    if (monthlyCents === null && annualCents === null && onetimeCents !== null) {
      return await oneTimeEstimatePricing(estimate, data);
    }
    if (monthlyCents !== null && onetimeCents === null && !estimate?.show_one_time_option) {
      return await monthlyMembershipEstimatePricing(estimate, monthlyCents);
    }
    return { pricingUnavailable: 'use_estimate_link' };
  } catch (err) {
    logger.warn('[lead-tools] check_existing_estimates: customer-facing pricing unavailable', { estimateId: estimate?.id, error: err.message });
    return { pricingUnavailable: 'use_estimate_link' };
  }
}

async function evaluateDeliveredEstimateRow(conn, row) {
  if (!isEstimateCustomerViewable(row)) return null;
  if (String(row?.status || '').toLowerCase() === 'sending') return null;
  const parsed = parseEstimateDataStrict(row.estimate_data);
  if (!parsed.ok) {
    logger.warn('[lead-tools] check_existing_estimates: malformed estimate_data hidden', { estimateId: row.id });
    return null;
  }
  // Require real delivery/publication evidence: declined rows can pass public
  // viewability without ever having been sent, and self-serve rows stamp
  // sent_at at mint time without delivering anything.
  const hasDeliveryEvidence = Boolean(row.sent_at || row.viewed_at || parsed.data?.deliveryState?.firstDeliveredAt);
  if (!hasDeliveryEvidence || isUndeliveredSelfServe(row.source, parsed.data)) return null;
  try {
    const blocked = await callSideBlockForEstimateData(conn, parsed.data, { estimateStatus: row.status });
    return blocked ? null : { row, data: parsed.data };
  } catch (err) {
    logger.warn('[lead-tools] check_existing_estimates: call-side verdict unavailable, row hidden', { estimateId: row.id, error: err.message });
    return null;
  }
}

async function loadExplicitLinkedEstimate(conn, customerId, explicitEstimateId) {
  if (!explicitEstimateId) return null;
  const row = await conn('estimates').where({ id: explicitEstimateId, customer_id: customerId }).first();
  if (!row) return null;
  return evaluateDeliveredEstimateRow(conn, row);
}

// Checks remaining rows past the 5-row display limit ONLY when an implicit
// binding candidate currently looks unique, so a 6th matching row cannot hide
// ambiguity without penalizing the normal paging stop when already ambiguous.
async function probeForAdditionalBindingMatches(conn, customerId, lead, seenIds, startPageRows, nextOffset, initialPlan) {
  if (lead?.estimate_id || !initialPlan.boundId) return initialPlan;
  const matches = [initialPlan.boundId];
  const checkCandidate = async (row) => {
    if (seenIds.has(String(row.id))) return false;
    seenIds.add(String(row.id));
    const evaluated = await evaluateDeliveredEstimateRow(conn, row);
    if (!evaluated || rowIdentifierConflict(evaluated, lead)) return false;
    const rec = estimateRecordedLeadId(evaluated.row, evaluated.data);
    if (lead?.id && rec && String(rec) === String(lead.id)) {
      matches.push(String(evaluated.row.id));
      return matches.length > 1;
    }
    if (lead?.property_id && evaluated.row?.property_id && String(evaluated.row.property_id) === String(lead.property_id)) {
      matches.push(String(evaluated.row.id));
      return matches.length > 1;
    }
    if (!lead?.property_id && !rec) {
      matches.push(String(evaluated.row.id));
      return matches.length > 1;
    }
    return false;
  };
  for (const row of startPageRows) {
    if (await checkCandidate(row)) return { boundId: null, fallbackReason: 'ambiguous_multiple_estimates' };
  }
  if (startPageRows.exhausted) return initialPlan;
  for (let offset = nextOffset; ; offset += VIEWABLE_PAGE) {
    const rows = await conn('estimates').where({ customer_id: customerId })
      .orderBy('created_at', 'desc').offset(offset).limit(VIEWABLE_PAGE);
    for (const row of rows) {
      if (await checkCandidate(row)) return { boundId: null, fallbackReason: 'ambiguous_multiple_estimates' };
    }
    if (rows.length < VIEWABLE_PAGE) break;
  }
  return initialPlan;
}

async function loadDeliveredViewableEstimates(conn, customerId, lead) {
  const entries = [];
  const seenIds = new Set();
  let hiddenCount = 0;
  const linked = await loadExplicitLinkedEstimate(conn, customerId, lead?.estimate_id || null);
  if (linked) {
    entries.push(linked);
    seenIds.add(String(linked.row.id));
  }
  let unreadInLastPage = [];
  let exhausted = false;
  let nextOffset = 0;
  for (let offset = 0; ; offset += VIEWABLE_PAGE) {
    const rows = await conn('estimates').where({ customer_id: customerId })
      .orderBy('created_at', 'desc').offset(offset).limit(VIEWABLE_PAGE);
    nextOffset = offset + VIEWABLE_PAGE;
    let i = 0;
    for (; i < rows.length; i += 1) {
      if (entries.length >= VIEWABLE_LIMIT) break;
      const row = rows[i];
      if (seenIds.has(String(row.id))) continue;
      seenIds.add(String(row.id));
      const evaluated = await evaluateDeliveredEstimateRow(conn, row);
      if (evaluated) entries.push(evaluated);
      else hiddenCount += 1;
    }
    if (entries.length >= VIEWABLE_LIMIT) {
      unreadInLastPage = rows.slice(i);
      exhausted = rows.length < VIEWABLE_PAGE;
      break;
    }
    if (rows.length < VIEWABLE_PAGE) {
      exhausted = true;
      break;
    }
  }
  const initialPlan = resolveLeadBindingPlan(entries, lead);
  unreadInLastPage.exhausted = exhausted;
  const bindingPlan = await probeForAdditionalBindingMatches(conn, customerId, lead, seenIds, unreadInLastPage, nextOffset, initialPlan);
  return { entries, hiddenCount, bindingPlan };
}

async function checkExistingEstimatesForLead(conn, subject, { estimateDeliverableUnderGate, shortenOrPassthrough }) {
  const customerId = subject.customer.id;
  const { entries, hiddenCount, bindingPlan } = await loadDeliveredViewableEstimates(conn, customerId, subject.lead);
  if (!entries.length) {
    return { hasEstimates: false, estimates: [], ...(hiddenCount ? { unviewableEstimates: hiddenCount } : {}) };
  }
  const estimates = await Promise.all(entries.map(async (entry) => {
    const e = entry.row;
    const authorityOk = await estimateDeliverableUnderGate(conn, e);
    const bindingReason = bindingReasonForRow(entry, subject.lead, bindingPlan);
    const linkable = authorityOk && !bindingReason && !!e.token;
    let pricingFields;
    if (!authorityOk) pricingFields = { totalWithheld: 'pricing-authority-not-server' };
    else if (bindingReason) pricingFields = { pricingUnavailable: bindingReason };
    else pricingFields = await customerFacingEstimatePricing(e, entry.data);
    const viewUrlWithheld = !authorityOk
      ? 'pricing-authority-not-server'
      : (bindingReason || 'no-token');
    return {
      id: e.id,
      status: e.status,
      ...pricingFields,
      serviceInterest: e.service_interest,
      sentAt: e.sent_at,
      viewedAt: e.viewed_at,
      token: linkable ? e.token : null,
      viewUrl: linkable
        ? await shortenOrPassthrough(
            `https://portal.wavespestcontrol.com/estimate/${e.token}`,
            { kind: 'estimate', entityType: 'estimates', entityId: e.id, customerId: e.customer_id || null },
          )
        : null,
      ...(linkable ? {} : { viewUrlWithheld }),
    };
  }));
  return {
    hasEstimates: true,
    ...(hiddenCount ? { unviewableEstimates: hiddenCount } : {}),
    estimates,
  };
}

// ── Outgoing SMS verbatim price verification ──────────────────

function normalizeForMatch(text) {
  return normalizeGsmPunctuation(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripVerifiedPriceSentences(message, sentences) {
  let remainder = normalizeForMatch(message);
  const sorted = [...new Set((sentences || []).map(normalizeForMatch).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const sentence of sorted) {
    const escaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remainder = remainder.replace(new RegExp(escaped, 'gi'), ' ');
  }
  return remainder.replace(/\s+/g, ' ').trim();
}

async function verifyLeadSmsQuotedPrices(message, conn, subject, { estimateDeliverableUnderGate }) {
  const normalized = normalizeForMatch(message);
  if (!UNVERIFIED_PRICE_SIGNAL_RE.test(normalized)) {
    return { ok: true, hasPrice: false };
  }
  try {
    const existing = await checkExistingEstimatesForLead(conn, subject, {
      estimateDeliverableUnderGate,
      shortenOrPassthrough: async (url) => url,
    });
    const allowedSentences = (existing.estimates || [])
      .flatMap((est) => (Array.isArray(est?.pricing?.priceSentences) ? est.pricing.priceSentences : []));
    if (!allowedSentences.length) {
      return { ok: false, hasPrice: true, reason: 'no_verified_estimate_pricing' };
    }
    const remainder = stripVerifiedPriceSentences(normalized, allowedSentences);
    if (UNVERIFIED_PRICE_SIGNAL_RE.test(remainder)) {
      return { ok: false, hasPrice: true, reason: 'unverified_price_outside_verbatim_sentence' };
    }
    return { ok: true, hasPrice: true };
  } catch (err) {
    logger.warn('[lead-tools] send_lead_response: price verification failed closed', { leadId: subject?.lead?.id, error: err.message });
    return { ok: false, hasPrice: true, reason: 'price_verification_unavailable' };
  }
}

module.exports = {
  checkExistingEstimatesForLead,
  verifyLeadSmsQuotedPrices,
};
