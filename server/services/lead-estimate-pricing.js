/**
 * Customer-facing estimate pricing & SMS dispatch price verification for the
 * Lead Response Agent.
 *
 * Every amount exposed to the lead agent or sent in an automated lead SMS must
 * come from a delivered, viewable, authority-approved estimate bound to the
 * assigned lead, with its exact customer-facing billing unit (per application,
 * one-time, or verified preserved monthly membership) and verified service
 * identity. Any ambiguity, lookup failure, or mismatch fails closed and routes
 * to staff review.
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
const { serviceKeysFromText } = require('./estimate-service-lines');

const VIEWABLE_LIMIT = 5;
const VIEWABLE_PAGE = 15;

// Matches dollar/currency amounts ("$149", "USD 199", "US$199", "$1,250.50") or
// number + currency/rate unit ("149 dollars", "149/mo", "149 per application").
const PRICE_MENTION_RE = /(?:us)?\$\s*(\d[\d,]*(?:\.\d{1,2})?)|\busd\s+(\d[\d,]*(?:\.\d{1,2})?)\b|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd|\/\s*(?:mo(?:nth)?|yr|year|app(?:lication)?|visit|tx|treatment)|per\s+(?:month|mo|year|yr|application|app|visit|treatment|service)|a\s+(?:month|year|application|visit)|one[\s-]time)\b/gi;

// Broad signal for any currency/price wording so unrecognized formats
// ("costs 199", "USD one hundred", "priced at 149") fail closed instead of
// bypassing dispatch verification.
const BROAD_PRICE_SIGNAL_RE = /\$\s*\d|\busd\b|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?|bucks|cents)\b|\b(?:costs?|price[ds]?|quoted?|rate|fee|charge[ds]?|total)\s*(?:is|of|at|for|:)?\s*(?:about\s+|around\s+|roughly\s+)?(?:us\$|\$|usd)?\s*\d/i;

const FORBIDDEN_UNIT_RE = /\bper\s+visit\b|\ba\s+visit\b|\/\s*visit\b/i;
const PER_APP_UNIT_RE = /\bper\s+application\b|\beach\s+application\b|\/\s*app(?:lication)?\b/i;
const ONE_TIME_UNIT_RE = /\bone[\s-]?time\b|\bsetup\s+fee\b/i;
const PER_MONTH_UNIT_RE = /\bper\s+month\b|\ba\s+month\b|\/\s*mo(?:nth)?\b|\bmonthly\b/i;
const CADENCE_COUNT_RE = /\b(\d{1,2})\s+(?:applications?(?:\s*(?:\/|\s+a|\s+per)\s*(?:yr|year))|times?\s+(?:a|per)\s+year)\b/i;

const NAMED_CADENCE_PATTERNS = [
  { re: /\b(?:quarterly|every\s+(?:3|three)\s+months?)\b/i, visits: 4 },
  { re: /\b(?:bi[\s-]?monthly|every\s+(?:2|two)\s+months?|every\s+other\s+month)\b/i, visits: 6 },
  { re: /\b(?:every\s+(?:4|four)\s+months?)\b/i, visits: 3 },
  { re: /\b(?:semi[\s-]?annual(?:ly)?|every\s+(?:6|six)\s+months?|twice\s+(?:a|per)\s+year)\b/i, visits: 2 },
  { re: /\b(?:annual(?:ly)?|yearly|once\s+(?:a|per)\s+year)\b/i, visits: 1 },
  { re: /\b(?:every\s+month)\b/i, visits: 12 },
];
const GENERIC_SCHEDULE_RE = /\b(?:every\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|other)\s+(?:days?|weeks?|months?|years?)|bi[\s-]?weekly|weekly|monthly|quarterly|bi[\s-]?monthly|semi[\s-]?annual(?:ly)?|annual(?:ly)?|yearly|twice\s+(?:a|per)\s+year|once\s+(?:a|per)\s+year)\b/gi;

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

function oneTimeServiceLabels(charges, estimate) {
  const fromItems = (charges || [])
    .map((item) => cleanEstimateLineLabel(
      item?.label || item?.name || item?.addOnKey || (item?.service !== 'area_addon' ? item?.service : ''),
    ))
    .filter(Boolean);
  if (fromItems.length) return fromItems;
  const interest = cleanEstimateLineLabel(estimate?.service_interest);
  return interest ? [interest] : [];
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
  for (const service of average.model.services) {
    const cents = positiveMoneyCents(service.perApplication);
    const applicationsPerYear = Math.round(Number(service.visits));
    if (!cents || !(applicationsPerYear > 0)) return null;
    const label = cleanEstimateLineLabel(service.label);
    lines.push({
      ...(label ? { label } : {}),
      amount: cents / 100,
      unit: 'per_application',
      applicationsPerYear,
      display: `${formatDollarsFromCents(cents)} per application (${applicationsPerYear} application${applicationsPerYear === 1 ? '' : 's'}/yr)`,
    });
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
  const parts = lines.map((line) => (line.label ? `${line.label}: ${line.display}` : line.display));
  const display = oneTimeCharge ? `${parts.join('; ')}; plus ${oneTimeCharge.display}` : parts.join('; ');
  return {
    pricing: {
      unit: 'per_application',
      lines,
      ...(oneTimeCharge ? { oneTimeCharge } : {}),
      display,
    },
  };
}

async function oneTimeEstimatePricing(estimate, onetimeCents, data) {
  let verifiedCents = onetimeCents;
  let breakdownItems = data?.sendSnapshot?.pricingBundle?.oneTimeBreakdown?.items
    || data?.oneTimeBreakdown?.items
    || null;
  if (!estimateIsPriceLocked(estimate)) {
    const resolved = await resolveLiveOneTimeBundle(estimate);
    if (resolved.reason) return { pricingUnavailable: resolved.reason };
    verifiedCents = resolved.cents;
    breakdownItems = resolved.items || breakdownItems;
  }
  const { unitKind, charges } = classifyOneTimeBreakdownItems(breakdownItems, data);
  if (unitKind === 'mixed') return { pricingUnavailable: 'use_estimate_link' };
  const suffix = unitKind === 'per_application' ? 'per application' : 'one-time';
  const serviceLabels = oneTimeServiceLabels(charges, estimate);
  return {
    pricing: {
      unit: unitKind,
      amount: verifiedCents / 100,
      ...(serviceLabels.length ? { serviceLabels } : {}),
      display: `${formatDollarsFromCents(verifiedCents)} ${suffix}`,
    },
  };
}

async function monthlyMembershipEstimatePricing(estimate, monthlyCents) {
  const [perApplication, prepaid] = await Promise.all([
    estimateBillsPerApplication(estimate, { rethrow: true }),
    estimateSoldAsAnnualPrepay(estimate, { rethrow: true }),
  ]);
  if (perApplication !== false || prepaid !== false) return { pricingUnavailable: 'use_estimate_link' };
  if (!estimateIsPriceLocked(estimate)) {
    const live = await resolveLivePricing(structuredClone(estimate), { rethrow: true });
    if (!live || live.unresolved || !live.bundle) return { pricingUnavailable: 'use_estimate_link' };
    if (live.bundle.quoteRequired === true) return { pricingUnavailable: 'quote_required' };
    if (live.snapshotHit !== true) return { pricingUnavailable: 'use_estimate_link' };
    const hasExtraFees = positiveMoneyCents(live.bundle.setupFee?.amount) !== null
      || (Array.isArray(live.bundle.firstVisitFees) && live.bundle.firstVisitFees.some((f) => positiveMoneyCents(f?.amount) !== null));
    if (hasExtraFees) return { pricingUnavailable: 'use_estimate_link' };
  }
  const label = cleanEstimateLineLabel(estimate?.service_interest);
  return {
    pricing: {
      unit: 'per_month',
      amount: monthlyCents / 100,
      ...(label ? { serviceLabels: [label] } : {}),
      display: `${formatDollarsFromCents(monthlyCents)} per month`,
    },
  };
}

// Resolves explicit lead/property evidence across the viewable set BEFORE
// applying the multi-estimate ambiguity fallback. Returns { boundId, fallbackReason }.
function resolveLeadBindingPlan(entries, lead) {
  if (lead?.estimate_id) return { boundId: String(lead.estimate_id), fallbackReason: 'different_lead_estimate' };
  if (lead?.id) {
    const leadMatches = entries.filter(({ row, data }) => {
      const rec = estimateRecordedLeadId(row, data);
      return rec && String(rec) === String(lead.id);
    });
    if (leadMatches.length === 1) return { boundId: String(leadMatches[0].row.id), fallbackReason: 'different_lead_estimate' };
    if (leadMatches.length > 1) return { boundId: null, fallbackReason: 'ambiguous_multiple_estimates' };
  }
  const eligible = entries.filter(({ row, data }) => {
    const rec = estimateRecordedLeadId(row, data);
    return !rec || !lead?.id || String(rec) === String(lead.id);
  });
  if (lead?.property_id) {
    const propMatches = eligible.filter(({ row }) => row?.property_id && String(row.property_id) === String(lead.property_id));
    if (propMatches.length === 1) return { boundId: String(propMatches[0].row.id), fallbackReason: 'different_property_estimate' };
    if (propMatches.length > 1) return { boundId: null, fallbackReason: 'ambiguous_multiple_estimates' };
    return { boundId: null, fallbackReason: 'different_property_estimate' };
  }
  if (entries.length === 1 && eligible.length === 1) return { boundId: String(entries[0].row.id), fallbackReason: null };
  return { boundId: null, fallbackReason: entries.length === 1 ? 'different_lead_estimate' : 'ambiguous_multiple_estimates' };
}

function bindingReasonForRow(entry, lead, plan) {
  if (plan.boundId && String(entry.row.id) === plan.boundId) return null;
  const rec = estimateRecordedLeadId(entry.row, entry.data);
  if (rec && lead?.id && String(rec) !== String(lead.id)) return 'different_lead_estimate';
  if (lead?.property_id && entry.row?.property_id && String(lead.property_id) !== String(entry.row.property_id)) {
    return 'different_property_estimate';
  }
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
      return await oneTimeEstimatePricing(estimate, onetimeCents, data);
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
  if (isUndeliveredSelfServe(row.source, parsed.data)) return null;
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

async function loadDeliveredViewableEstimates(conn, customerId, explicitEstimateId = null) {
  const entries = [];
  const seenIds = new Set();
  let hiddenCount = 0;
  // Fetch the lead's explicitly linked estimate first (within the assigned
  // customer scope) so 5 newer customer estimates cannot mask it.
  const linked = await loadExplicitLinkedEstimate(conn, customerId, explicitEstimateId);
  if (linked) {
    entries.push(linked);
    seenIds.add(String(linked.row.id));
  }
  for (let offset = 0; ; offset += VIEWABLE_PAGE) {
    const rows = await conn('estimates').where({ customer_id: customerId })
      .orderBy('created_at', 'desc').offset(offset).limit(VIEWABLE_PAGE);
    for (const row of rows) {
      if (entries.length >= VIEWABLE_LIMIT) break;
      if (seenIds.has(String(row.id))) continue;
      seenIds.add(String(row.id));
      const evaluated = await evaluateDeliveredEstimateRow(conn, row);
      if (evaluated) entries.push(evaluated);
      else hiddenCount += 1;
    }
    if (entries.length >= VIEWABLE_LIMIT || rows.length < VIEWABLE_PAGE) break;
  }
  return { entries, hiddenCount };
}

async function checkExistingEstimatesForLead(conn, subject, { estimateDeliverableUnderGate, shortenOrPassthrough }) {
  const customerId = subject.customer.id;
  const { entries, hiddenCount } = await loadDeliveredViewableEstimates(conn, customerId, subject.lead?.estimate_id || null);
  if (!entries.length) {
    return { hasEstimates: false, estimates: [], ...(hiddenCount ? { unviewableEstimates: hiddenCount } : {}) };
  }
  const bindingPlan = resolveLeadBindingPlan(entries, subject.lead);
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

// ── Outgoing SMS price verification ───────────────────────────

function extractPriceMentions(message) {
  const text = String(message || '');
  const raw = [];
  PRICE_MENTION_RE.lastIndex = 0;
  let match = PRICE_MENTION_RE.exec(text);
  while (match) {
    const numStr = (match[1] || match[2] || match[3] || '').replace(/,/g, '');
    const cents = Math.round(Number(numStr) * 100);
    if (Number.isFinite(cents) && cents >= 0) {
      raw.push({ index: match.index, end: match.index + match[0].length, cents, rawText: match[0] });
    }
    match = PRICE_MENTION_RE.exec(text);
  }
  return raw.map((item, idx) => {
    const prevEnd = idx > 0 ? raw[idx - 1].end : 0;
    const nextStart = idx + 1 < raw.length ? raw[idx + 1].index : text.length;
    const leftBound = Math.max(prevEnd, text.lastIndexOf('.', item.index) + 1, text.lastIndexOf(';', item.index) + 1, text.lastIndexOf('\n', item.index) + 1);
    const rightCandidates = [nextStart, text.indexOf('.', item.end), text.indexOf(';', item.end), text.indexOf('!', item.end), text.indexOf('?', item.end), text.indexOf('\n', item.end)]
      .filter((pos) => pos >= item.end);
    const rightBound = Math.min(...rightCandidates);
    const clause = text.slice(leftBound, rightBound);
    const localAround = text.slice(Math.max(leftBound, item.index - 25), Math.min(rightBound, item.end + 45));
    return { ...item, clause, localAround };
  });
}

function detectMentionUnit(mention) {
  const scope = mention.localAround;
  if (FORBIDDEN_UNIT_RE.test(scope)) return { error: 'forbidden_per_visit_unit' };
  const units = [];
  if (PER_APP_UNIT_RE.test(scope)) units.push('per_application');
  if (ONE_TIME_UNIT_RE.test(scope)) units.push('one_time');
  if (PER_MONTH_UNIT_RE.test(scope)) units.push('per_month');
  if (units.length === 0) return { error: 'missing_price_unit' };
  if (units.length > 1) return { error: 'ambiguous_price_unit' };
  return { unit: units[0] };
}

function schedulePhraseMatches(phrase, claim) {
  if (/^monthly$/i.test(phrase) && claim.unit === 'per_month') return true;
  if (!claim.applicationsPerYear) return false;
  const hit = NAMED_CADENCE_PATTERNS.find((entry) => entry.re.test(phrase));
  return !!hit && hit.visits === claim.applicationsPerYear;
}

function cadenceMatchesClaim(clause, claim) {
  const countMatch = CADENCE_COUNT_RE.exec(clause);
  if (countMatch && (!claim.applicationsPerYear || Number(countMatch[1]) !== claim.applicationsPerYear)) {
    return false;
  }
  const phrases = clause.match(GENERIC_SCHEDULE_RE) || [];
  return phrases.every((phrase) => schedulePhraseMatches(phrase, claim));
}

function claimsFromVerifiedEstimate(estimate) {
  const pricing = estimate?.pricing;
  if (!pricing) return [];
  const claims = [];
  if (Array.isArray(pricing.lines)) {
    for (const line of pricing.lines) {
      const cents = positiveMoneyCents(line.amount);
      if (!cents) continue;
      claims.push({
        cents,
        unit: line.unit,
        applicationsPerYear: line.applicationsPerYear || null,
        serviceKeys: serviceKeysFromText(line.label || estimate.serviceInterest),
        isSetupFee: false,
      });
    }
    if (pricing.oneTimeCharge) {
      const feeCents = positiveMoneyCents(pricing.oneTimeCharge.amount);
      if (feeCents) {
        claims.push({ cents: feeCents, unit: 'one_time', applicationsPerYear: null, serviceKeys: [], isSetupFee: true });
      }
    }
    return claims;
  }
  const cents = positiveMoneyCents(pricing.amount);
  if (cents) {
    const labelText = Array.isArray(pricing.serviceLabels) && pricing.serviceLabels.length
      ? pricing.serviceLabels.join(' ')
      : estimate.serviceInterest;
    claims.push({
      cents,
      unit: pricing.unit,
      applicationsPerYear: null,
      serviceKeys: serviceKeysFromText(labelText),
      isSetupFee: false,
    });
  }
  return claims;
}

function claimMatchesMention(claim, mention, unit, messageServiceKeys) {
  if (claim.cents !== mention.cents || claim.unit !== unit) return false;
  if (claim.isSetupFee) return /\bsetup\b/i.test(mention.clause);
  if (!cadenceMatchesClaim(mention.clause, claim)) return false;
  // Require a verified service identity on every non-setup price claim so an
  // unidentified estimate can never authorize arbitrary service wording.
  if (!claim.serviceKeys.length) return false;
  const clauseKeys = serviceKeysFromText(mention.clause);
  const effectiveKeys = clauseKeys.length ? clauseKeys : messageServiceKeys;
  if (!effectiveKeys.some((key) => claim.serviceKeys.includes(key))) return false;
  return !clauseKeys.some((key) => !claim.serviceKeys.includes(key));
}

async function verifyLeadSmsQuotedPrices(message, conn, subject, { estimateDeliverableUnderGate }) {
  const text = String(message || '');
  const mentions = extractPriceMentions(text);
  if (!mentions.length) {
    if (BROAD_PRICE_SIGNAL_RE.test(text)) {
      return { ok: false, hasPrice: true, reason: 'unrecognized_price_wording' };
    }
    return { ok: true, hasPrice: false };
  }
  try {
    const existing = await checkExistingEstimatesForLead(conn, subject, {
      estimateDeliverableUnderGate,
      shortenOrPassthrough: async (url) => url,
    });
    const claims = (existing.estimates || []).flatMap(claimsFromVerifiedEstimate);
    if (!claims.length) return { ok: false, hasPrice: true, reason: 'no_verified_estimate_pricing' };
    const messageServiceKeys = serviceKeysFromText(text);
    for (const mention of mentions) {
      const parsedUnit = detectMentionUnit(mention);
      if (parsedUnit.error) return { ok: false, hasPrice: true, reason: parsedUnit.error };
      const matched = claims.some((claim) => claimMatchesMention(claim, mention, parsedUnit.unit, messageServiceKeys));
      if (!matched) return { ok: false, hasPrice: true, reason: 'price_or_service_mismatch' };
    }
    return { ok: true, hasPrice: true };
  } catch (err) {
    logger.warn('[lead-tools] send_lead_response: price verification failed closed', { leadId: subject?.lead?.id, error: err.message });
    return { ok: false, hasPrice: true, reason: 'price_verification_unavailable' };
  }
}

module.exports = {
  checkExistingEstimatesForLead,
  extractPriceMentions,
  verifyLeadSmsQuotedPrices,
};
