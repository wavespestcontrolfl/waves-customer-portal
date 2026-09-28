const logger = require('./logger');
const MODELS = require('../config/models');
const db = require('../models/db');
const { WAVEGUARD } = require('./pricing-engine/constants');
const { serviceCountsTowardWaveGuardTier } = require('./pricing-engine/discount-engine');
const { loadEstimateAiSupportContext, serviceKeysFromContext, serviceFamiliesFromText } = require('./estimate-ai-context');
const { dispatch, rejectCall } = require('./llm/call');
const { isMistingSystemService } = require('../utils/mosquito-misting-system');
const { ledgerCall, ledgerCallRejected } = require('./llm-dispatch-metrics');
const { GUARANTEE_COPY, resolveOneTimeServiceCopy } = require('./estimate-one-time-copy');
const {
  collapseMirroredRows,
  hasPurchasedTrenchingWarranty,
  isPreSlabTreatmentItem,
  preSlabExtendedWarrantySelected,
  preSlabSelectedWarrantyPart,
  preSlabWarrantyDecision,
  rawOneTimeWarrantyEvidenceItems,
  reconcilePricedPreSlabWarrantyEvidence,
  reconcileTrenchingWarrantyEvidence,
  reconcilePricedTrenchingWarrantyEvidence,
  trenchingServiceIdentity,
} = require('../../shared/estimate-purchased-warranty.cjs');
const { serviceKeysFromText } = require('./estimate-service-lines');
const { RECURRING_TERMS_LANES, TERMITE_LANES } = require('./estimate-followup-copy');
const { normalizeBondTermService } = require('./estimate-converter');

// Neutral categories may retain their own satisfaction wording, but cannot
// inherit residential membership promises from saved service prose.
const { PLAN_TERMS_COPY, withoutClaimsOutsideScope } = require('../../shared/estimate-copy-claims.cjs');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const COMPANY = {
  name: 'Waves Pest Control',
  phone: '(941) 297-5749',
  phoneRaw: '+19412975749',
  email: 'contact@wavespestcontrol.com',
  serviceArea: 'Southwest Florida',
};

const SYSTEM_PROMPT = `You are Waves AI on a customer-facing estimate page for Waves Pest Control.

Answer questions about the customer's estimate, Waves services, WaveGuard, billing, scheduling, pest control, and lawn care.

Rules:
- Use only the estimate context for prices, services selected, schedules, discounts, billing terms, and property details.
- Honor guarantees.noGuaranteeClaims. When true, do not infer an estimate-wide callback, satisfaction, re-treatment, or money-back guarantee. Proven service-specific purchasedTerms may still be described, without generalizing them to the estimate.
- Recurring callbacks, money-back, and no-contract terms apply only when guarantees.recurringTermsEligible is true. A neutral category's written satisfaction wording may be described only for that service and never authorizes these recurring terms.
- A row's purchasedTerms lists proven service-specific purchased benefits. Describe only those terms; they never authorize an estimate-wide guarantee.
- When guarantees.serviceTerms is present, answer any guarantee, warranty, bond, or callback question by stating each listed service's terms under that service's name, whichever service the question mentions. A service that is not listed has no stated terms. Never apply a listed term to the whole estimate or to another service.
- Use the supportContext for service procedures, products, label/safety references, and Waves admin knowledge. Do not expose internal cost notes.
- Never give customer-facing product brand names. If product context is relevant, use active ingredients, treatment classes, and how the treatment works.
- If neither the estimate context nor supportContext contains a specific fact, say you do not see it and suggest calling or texting Waves.
- Do not make appointments, accept estimates, cancel service, reschedule service, promise arrival times, diagnose medical risk, or guarantee chemical safety.
- Keep answers concise: 2-4 short sentences.
- Plain text only. Do not use Markdown, bold markers, headings, or bullet lists.
- Be clear, friendly, and practical.`;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanAssistantAnswer(value) {
  return cleanText(String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, ''));
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function normalizeServiceName(value) {
  const raw = cleanText(value);
  const key = raw.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\bpalms?\b|\bpalm injection\b/.test(key)) return 'Palm Injection';
  if (/rodent/.test(key) && /bait|station|monitor/.test(key)) return 'Rodent Bait Stations';
  if (/lawn|turf|weed|fung/.test(key)) return 'Lawn Care';
  if (/mosquito/.test(key)) return 'Mosquito Control';
  if (/termite/.test(key)) return 'Termite Service';
  if (/tree|shrub|ornamental/.test(key)) return 'Tree & Shrub Service';
  if (/rodent|rat|mouse/.test(key)) return 'Rodent Control';
  if (/pest|roach|ant|spider|perimeter/.test(key)) return 'Pest Control';
  return raw || 'Service';
}

function normalizedServiceRowLabel(row = {}) {
  const service = cleanText(row.service || row.serviceKey || row.service_key || row.key).toLowerCase();
  if (service.startsWith('termite_bond')) return 'Termite Bond';
  return normalizeServiceName(row.displayName || row.label || row.name || row.service || row.serviceKey);
}

function uniqueByLabel(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const label = cleanText(row.label).toLowerCase();
    if (!label || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

function normalizeBillingFrequencyKey(value) {
  const raw = cleanText(value).toLowerCase().replace(/[_\s-]+/g, '_');
  if (!raw) return null;
  if (raw === '6' || raw.includes('bi_month') || raw.includes('bimonth')) return 'bi_monthly';
  if (raw === '12' || raw.includes('monthly') || raw === 'month') return 'monthly';
  if (raw === '4' || raw.includes('quarter')) return 'quarterly';
  return null;
}

function periodLabelForFrequency(frequency = {}) {
  const explicitBillingKey = cleanText(
    frequency.billingFrequencyKey
      || frequency.billingFrequency
      || frequency.billingCadenceKey
      || frequency.billingCadence,
  );
  const key = normalizeBillingFrequencyKey(explicitBillingKey || frequency.key);
  if (key === 'bi_monthly') return 'bi-monthly visit';
  if (key === 'monthly') return 'month';
  if (key === 'quarterly') return 'quarter';
  const labelKey = explicitBillingKey ? null : normalizeBillingFrequencyKey(frequency.label);
  if (labelKey === 'bi_monthly') return 'bi-monthly visit';
  if (labelKey === 'monthly') return 'month';
  return 'quarter';
}

function billingAmountForFrequency(frequency = {}) {
  const monthly = Number(frequency.monthly);
  if (!Number.isFinite(monthly) || monthly <= 0) return null;
  const period = periodLabelForFrequency(frequency);
  const months = period === 'quarter' ? 3 : (period === 'bi-monthly visit' ? 2 : 1);
  return Math.round(monthly * months * 100) / 100;
}

function parseEstimateData(estData) {
  if (!estData) return {};
  if (typeof estData === 'string') {
    try { return JSON.parse(estData); } catch { return {}; }
  }
  return typeof estData === 'object' ? estData : {};
}

function guaranteeLanesForRow(row) {
  const lanes = serviceKeysFromText(row.service, row.serviceKey, row.service_key, row.key, row.displayName, row.label, row.name);
  return row.isCommercial === true
    ? lanes.map((lane) => lane.startsWith('commercial_') ? lane : `commercial_${lane}`)
    : lanes;
}

function termiteBondPurchasedTerms(row = {}, selectedTerms = []) {
  const normalized = normalizeBondTermService(row);
  const service = cleanText([
    normalized.service, normalized.serviceKey, normalized.service_key, normalized.key,
  ].find(Boolean)).toLowerCase();
  const keyedMatch = service.match(/^termite_bond_(1|5|10)yr$/);
  const keyedTerm = keyedMatch?.[1];
  const rawTerms = ['bondTerm', 'selectedBondTerm']
    .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
    .map((key) => row[key])
    .concat(selectedTerms)
    .map((value) => cleanText(value).toLowerCase());
  if (service !== 'termite_bond' && !keyedMatch) return [];
  if (rawTerms.some((value) => !/^(1|5|10)yr$/.test(value))) return [];
  const termCandidates = [keyedTerm, ...rawTerms, normalized.bondYears, normalized.years]
    .filter((value) => value !== undefined && value !== null && value !== '');
  const years = Number(String(termCandidates[0]).replace(/yr$/, ''));
  if (![1, 5, 10].includes(years)) return [];
  if (termCandidates.some((value) => Number(String(value).replace(/yr$/, '')) !== years)) return [];
  const paid = [
    normalized.perTreatment, normalized.perApp, normalized.perVisit, normalized.monthly,
    normalized.mo, normalized.annual, normalized.amount, normalized.price,
  ]
    .some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  return paid ? [`Purchased termite bond: ${years}-year term with re-treatment coverage.`] : [];
}

function withTermiteBondPurchasedTerms(row, proofRow = row, selectedTerms = []) {
  const normalizedProof = normalizeBondTermService(proofRow);
  const service = cleanText([
    normalizedProof.service, normalizedProof.serviceKey, normalizedProof.service_key, normalizedProof.key,
  ].find(Boolean)).toLowerCase();
  if (!service.startsWith('termite_bond')) return row;
  const purchasedTerms = termiteBondPurchasedTerms(normalizedProof, selectedTerms);
  return { ...row, service: row.service || service, purchasedTerms };
}

function rawRecurringServiceRows(estData = {}) {
  // mergeServiceRows applies later matching values over earlier ones. Keep
  // every container for identity/term evidence, while ordering the saved
  // result last so its current display fields outrank historical engine data.
  const containers = [...new Set([estData, estData.engineResult, estData.result]
    .filter((value) => value && typeof value === 'object'))];
  return containers.flatMap((result) => {
    const recurring = result.recurring || {};
    const nestedRecurring = result.results?.recurring || {};
    return [
      ...(Array.isArray(recurring.services) ? recurring.services : []),
      ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
      ...(Array.isArray(result.lineItems)
        ? result.lineItems.filter((row) => {
          const normalized = normalizeBondTermService(row);
          const lanes = guaranteeLanesForRow(row);
          const service = cleanText([
            normalized.service, normalized.serviceKey, normalized.service_key, normalized.key,
          ].find(Boolean)).toLowerCase();
          const recurringValue = [row.monthly, row.mo, row.annual, row.perTreatment, row.perApp, row.perVisit]
            .some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
          const commercial = lanes.some((lane) => lane.startsWith('commercial_'));
          return service.startsWith('termite_bond')
            || (service === 'termite_bait' && Object.prototype.hasOwnProperty.call(row, 'selectedBondTerm'))
            || (commercial && (recurringValue || row.quoteRequired === true || row.requiresManualReview === true))
            || (recurringValue && lanes.includes('rodent'))
            // Ordinary termite work (no bond decision) still names its own
            // service in the per-service terms, as "No guarantee.".
            || (recurringValue && lanes.some((lane) => TERMITE_LANES.has(lane)));
        })
        : []),
    ];
  });
}

function bondTermConstraintsForRow(row = {}) {
  const normalized = normalizeBondTermService(row);
  const service = cleanText([
    normalized.service, normalized.serviceKey, normalized.service_key, normalized.key,
  ].find(Boolean)).toLowerCase();
  if (!service.startsWith('termite_bond') && service !== 'termite_bait') return [];
  const selected = Object.prototype.hasOwnProperty.call(row, 'selectedBondTerm')
    ? [row.selectedBondTerm] : [];
  if (service === 'termite_bait') return selected;
  const terms = ['bondTerm', 'bondYears', 'years']
    .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
    .filter((key) => key === 'bondTerm' || (row[key] != null && row[key] !== ''))
    .map((key) => key === 'bondTerm' ? row[key] : `${row[key]}yr`);
  const keyedTerm = service.match(/^termite_bond_(.+)$/)?.[1];
  const prices = ['perTreatment', 'perApp', 'perVisit', 'monthly', 'mo', 'annual', 'amount', 'price']
    .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
    .filter((key) => row[key] != null && String(row[key]).trim() !== '')
    .map((key) => Number(row[key]));
  const removedPrice = prices.length > 0 && !prices.some((value) => Number.isFinite(value) && value > 0);
  return [...selected, ...terms, ...(keyedTerm ? [keyedTerm] : []), ...(removedPrice ? ['none'] : [])];
}

function selectedBondTermsFromEstimateData(parsedData, rawServices, frequency) {
  const selectors = [
    ['inputs', 'termiteBondTerm'],
    ['engineInputs', 'services', 'termite', 'bondTerm'],
    ['engineRequest', 'services', 'termite', 'bondTerm'],
    ['engineInputs', 'options', 'termiteBondTerm'],
    ['engineRequest', 'options', 'termiteBondTerm'],
    ['result', 'results', 'tmBait', 'selectedBondTerm'],
    // readV1Shape's top-level legacy form (result.tmBait) is current too.
    ['result', 'tmBait', 'selectedBondTerm'],
    ['results', 'tmBait', 'selectedBondTerm'],
  ].flatMap((path) => {
    const source = path.slice(0, -1).reduce((value, key) => value?.[key], parsedData);
    const key = path[path.length - 1];
    return source && Object.prototype.hasOwnProperty.call(source, key) ? [source[key]] : [];
  });
  if (selectors.length) return { terms: selectors, authoritative: true };
  // Without an authoritative selector these unversioned snapshots must agree.
  // Neither list order nor a frozen pricing projection can restore an explicit
  // removal, a contradictory term, or a zero-price current bond decision.
  const engineStats = parsedData.engineResult?.results?.tmBait;
  const engineSelector = engineStats && Object.prototype.hasOwnProperty.call(engineStats, 'selectedBondTerm')
    ? [engineStats.selectedBondTerm] : [];
  const terms = [
    ...rawServices,
    ...(Array.isArray(frequency?.included) ? frequency.included : []),
    ...(Array.isArray(frequency?.perServiceTreatments) ? frequency.perServiceTreatments : []),
  ].flatMap(bondTermConstraintsForRow).concat(engineSelector);
  return { terms, authoritative: false };
}

function serviceRowsFromEstimateData(services = [], bondSelection = { terms: [], authoritative: false }) {
  const rows = services.map((service) => withTermiteBondPurchasedTerms({
    service: cleanText(service.service || service.serviceKey || service.service_key || service.key) || null,
    guaranteeLanes: guaranteeLanesForRow(service),
    label: normalizedServiceRowLabel(service),
    cadence: cleanText(service.frequencyLabel || service.cadence || service.frequency),
    detail: cleanText(service.detail || service.description),
    monthly: Number(service.mo ?? service.monthly ?? service.monthlyTotal),
    visitsPerYear: Number(service.visitsPerYear ?? service.visits ?? service.apps),
    perApplication: Number(service.perTreatment ?? service.perApp ?? service.perVisit),
  }, service, bondSelection.terms));
  // Once the saved selector states a term, contradicted historical bond rows
  // no longer participate in merging. Otherwise their empty terms could
  // replace the valid selected row. An explicit removal excludes every bond.
  return rows.filter((row) => !bondSelection.authoritative
    || !row.service?.startsWith('termite_bond') || row.purchasedTerms.length);
}

function waveGuardDiscountForTier(value) {
  const key = cleanText(value)
    .toLowerCase()
    .replace(/^waveguard\s+/, '');
  return WAVEGUARD.tiers[key]?.discount || 0;
}

function waveGuardDiscountAppliesToService(service = {}) {
  const key = cleanText(service.service || service.key).toLowerCase();
  // rodent_bait is a WaveGuard member since 2026-08-29 (codex #3591 r2 P1)
  // — it flows through serviceCountsTowardWaveGuardTier below; legacy rows
  // still refuse via their waveGuardDiscountEligible:false flag.
  if (key === 'palm_injection' || service.waveGuardDiscountEligible === false) return false;
  if (key && serviceCountsTowardWaveGuardTier(key)) return true;
  const rawLabel = cleanText(service.label || service.name || service.service).toLowerCase();
  if ((/\bpalms?\b|\bpalm injection\b/.test(rawLabel)) || (rawLabel.includes('rodent') && rawLabel.includes('bait'))) return false;
  const label = normalizeServiceName(service.label || service.name || service.service);
  return ['Pest Control', 'Lawn Care', 'Mosquito Control', 'Termite Service', 'Tree & Shrub Service'].includes(label);
}

function serviceRowsFromPricing(pricingBundle = {}, selectedFrequency = null, selectedBondTerms) {
  const frequency = selectedFrequency || (Array.isArray(pricingBundle.frequencies) ? pricingBundle.frequencies[0] : null);
  const included = Array.isArray(frequency?.included) ? frequency.included : [];
  const perTreatments = Array.isArray(frequency?.perServiceTreatments) ? frequency.perServiceTreatments : [];
  const byLabel = new Map();
  const serviceCadence = frequency?.billingFrequencyKey && frequency.billingFrequencyKey !== frequency.key
    ? cleanText(frequency.label)
    : '';
  const waveGuardDiscount = waveGuardDiscountForTier(pricingBundle.waveGuardTier);
  const targetAnnual = Number(frequency?.annual)
    || (Number.isFinite(Number(frequency?.monthly)) ? Number(frequency.monthly) * 12 : null);
  const treatmentAnnualFor = (service) => {
    const amount = Number(service.perTreatment);
    const visits = Number(service.visitsPerYear);
    return Number.isFinite(amount) && amount > 0 && Number.isFinite(visits) && visits > 0
      ? amount * visits
      : 0;
  };
  const rawTreatmentAnnual = perTreatments.reduce((sum, service) => sum + treatmentAnnualFor(service), 0);
  const enginePricedRows = ['v1_engine_shape', 'engine_invocation'].includes(cleanText(pricingBundle.source));
  const shouldApplyTierDiscount = waveGuardDiscount > 0
    && (enginePricedRows || (
      Number.isFinite(targetAnnual)
      && targetAnnual > 0
      && rawTreatmentAnnual > targetAnnual + 0.5
    ));
  const afterTierAnnual = perTreatments.reduce((sum, service) => {
    const annual = treatmentAnnualFor(service);
    const multiplier = shouldApplyTierDiscount && waveGuardDiscountAppliesToService(service)
      ? (1 - waveGuardDiscount)
      : 1;
    return sum + annual * multiplier;
  }, 0);
  const nonDiscountedAnnual = perTreatments.reduce((sum, service) => {
    return sum + (waveGuardDiscountAppliesToService(service) ? 0 : treatmentAnnualFor(service));
  }, 0);
  const discountableAfterTierAnnual = Math.max(0, afterTierAnnual - nonDiscountedAnnual);
  const discountableAdjustment = Number.isFinite(targetAnnual)
    && targetAnnual > 0
    && afterTierAnnual > targetAnnual + 0.5
    && discountableAfterTierAnnual > 0
    ? Math.max(0, (targetAnnual - nonDiscountedAnnual) / discountableAfterTierAnnual)
    : 1;

  included.forEach((service) => {
    const label = normalizedServiceRowLabel(service);
    const current = byLabel.get(label) || { label };
    byLabel.set(label, withTermiteBondPurchasedTerms({
      ...current,
      service: current.service || cleanText(service.service || service.serviceKey || service.service_key || service.key) || null,
      guaranteeLanes: [...new Set([...(current.guaranteeLanes || []), ...guaranteeLanesForRow(service)])],
      label,
      cadence: current.cadence || serviceCadence,
      detail: current.detail || cleanText(service.detail),
      ...(service.bondTerm != null ? { bondTerm: service.bondTerm } : {}),
      ...(service.bondYears != null ? { bondYears: service.bondYears } : {}),
    }, service, selectedBondTerms));
  });

  perTreatments.forEach((service) => {
    const label = normalizedServiceRowLabel(service);
    const current = byLabel.get(label) || { label };
    const rawPerTreatment = Number(service.perTreatment);
    const rowMultiplier = waveGuardDiscountAppliesToService(service)
      ? (shouldApplyTierDiscount ? (1 - waveGuardDiscount) : 1) * discountableAdjustment
      : 1;
    const perApplication = Number.isFinite(rawPerTreatment) && rawPerTreatment > 0
      ? Math.round(rawPerTreatment * rowMultiplier * 100) / 100
      : null;
    byLabel.set(label, withTermiteBondPurchasedTerms({
      ...current,
      service: current.service || cleanText(service.service || service.serviceKey || service.service_key || service.key) || null,
      guaranteeLanes: [...new Set([...(current.guaranteeLanes || []), ...guaranteeLanesForRow(service)])],
      perApplication,
      visitsPerYear: Number(service.visitsPerYear),
      ...(service.bondTerm != null ? { bondTerm: service.bondTerm } : {}),
      ...(service.bondYears != null ? { bondYears: service.bondYears } : {}),
    }, service, selectedBondTerms));
  });

  return [...byLabel.values()];
}

function mergeServiceRows(primaryRows = [], fallbackRows = [], options = {}) {
  const byLabel = new Map();
  const allowFallbackOnly = options.allowFallbackOnly !== false;
  const primaryLabels = new Set(primaryRows.map((row) => (
    row.oneTime
      ? (cleanText(row.label) || 'One-time service')
      : normalizedServiceRowLabel(row)
  )));
  [...fallbackRows, ...primaryRows].forEach((row) => {
    const label = row.oneTime
      ? (cleanText(row.label) || 'One-time service')
      : normalizedServiceRowLabel(row);
    const current = byLabel.get(label) || { label };
    const primaryOmitsLegacyTerms = row.oneTime && current.oneTime
      && !Object.prototype.hasOwnProperty.call(row, 'purchasedTerms');
    const currentService = cleanText(current.service).replace(/^trenching$/, 'termite_trenching');
    const rowService = cleanText(row.service).replace(/^trenching$/, 'termite_trenching');
    if (primaryOmitsLegacyTerms && currentService && rowService && currentService !== rowService) {
      delete current.purchasedTerms;
    }
    const recurringPurchasedTerms = !row.oneTime && !current.oneTime
      && (Array.isArray(current.purchasedTerms) || Array.isArray(row.purchasedTerms))
      ? [...new Set([...(current.purchasedTerms || []), ...(row.purchasedTerms || [])])]
      : null;
    byLabel.set(label, {
      ...current,
      ...Object.fromEntries(Object.entries(row).filter(([key, value]) => {
        // An authoritative row can remove a previously sold warranty. Its
        // empty terms array must clear the saved benefit, not inherit it.
        if (key === 'purchasedTerms') return Array.isArray(value);
        // A pre-slab row's warranty selection is authoritative either way:
        // false must survive the merge, or the row falls back to stale
        // detail text that still names the removed extended warranty.
        if (key === 'warrantyExtendedSelected') return typeof value === 'boolean' || value === null;
        // Its status travels with it: null clears a sibling's lent text.
        if (key === 'warrantyStatus') return value === null || Boolean(cleanText(value));
        if (typeof value === 'number') return Number.isFinite(value) && value > 0;
        return cleanText(value);
      })),
      ...(recurringPurchasedTerms ? { purchasedTerms: recurringPurchasedTerms } : {}),
      label,
    });
  });
  // Apply the frozen projection only after current rows have replaced saved
  // terms. An empty current bond decision must clear an older purchased bond
  // even when the frozen pricing projection has no separate bond row.
  return uniqueByLabel([...byLabel.values()].filter((row) => (
    allowFallbackOnly || primaryLabels.has(row.label) || (row.purchasedTerms || []).length
  )));
}

// A pre-slab job's warranty, worded as the page words it (routes/
// estimate-public.js preSlabCustomerCopy): the engine prices a basic tier by
// default and the extended 5-year tier as a paid add-on. Owner ruling
// 2026-09-27: a selected pre-slab warranty is stated, never "no guarantee".
function preSlabWarrantyTerms(item) {
  return preSlabWarrantyTermsForDecision(preSlabWarrantyDecision(item));
}
function preSlabWarrantyTermsForDecision(decision) {
  return decision === 'extended'
    ? ['Extended 5-year warranty selected. Warranty terms depend on the selected warranty option.']
    : ['Warranty terms depend on the selected warranty option. No extended warranty selected.'];
}

function purchasedTermsForRow(item) {
  if (!hasPurchasedTrenchingWarranty(item)) return [];
  const copy = resolveOneTimeServiceCopy(item, { noGuaranteeClaims: true });
  return (copy?.includes || []).filter((line) => GUARANTEE_COPY.test(line));
}

function mergeOneTimeServiceRows(primaryRows = [], fallbackRows = []) {
  const primaryLabelsByService = new Map();
  for (const row of primaryRows) {
    const service = trenchingServiceIdentity(row);
    if (!service) continue;
    const labels = primaryLabelsByService.get(service) || new Set();
    labels.add(cleanText(row.label));
    primaryLabelsByService.set(service, labels);
  }
  const unmatchedFallbackRows = fallbackRows.filter((row) => {
    const labels = primaryLabelsByService.get(trenchingServiceIdentity(row));
    return !labels || labels.has(cleanText(row.label));
  });
  const primaryIdentityCounts = primaryRows.reduce((counts, row) => {
    const key = `${trenchingServiceIdentity(row)}|${cleanText(row.label).toLowerCase()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  const duplicateIdentities = new Set([...primaryIdentityCounts]
    .filter(([, count]) => count > 1).map(([key]) => key));
  if (!duplicateIdentities.size) return mergeServiceRows(primaryRows, unmatchedFallbackRows);
  const identityFor = (row) => `${trenchingServiceIdentity(row)}|${cleanText(row.label).toLowerCase()}`;
  // Distinct priced jobs can legitimately share a customer-facing label. Their
  // already-reconciled current terms must survive instead of being coalesced by
  // the general label merger; ambiguous fallback rows cannot enrich either.
  return [
    ...primaryRows.filter((row) => duplicateIdentities.has(identityFor(row))),
    ...mergeServiceRows(
      primaryRows.filter((row) => !duplicateIdentities.has(identityFor(row))),
      unmatchedFallbackRows.filter((row) => !duplicateIdentities.has(identityFor(row))),
    ),
  ];
}

// A pre-slab row's authoritative warranty selection travels with its
// projection (warrantyExtendedSelected, else its warrantyStatus text), so
// preSlabSelectedWarrantyPart reads the selection, never stale detail text
// that still names the removed extended warranty (pre-push audit P1 on
// 5c8876e256). Other rows carry nothing extra.
// `evidence` is the row whose warranty decision governs (the priced row
// itself, or the saved row reconcilePricedPreSlabWarrantyEvidence matched
// it to when the priced row carries no decision), so the stated terms and
// the kept detail part agree.
function preSlabProjectionFields(item = {}, evidence = item) {
  if (!isPreSlabTreatmentItem(item)) return {};
  const decided = evidence && typeof evidence === 'object' ? evidence : item;
  // One decision (preSlabWarrantyDecision) drives the terms, the stamped
  // boolean and the status, so they can never disagree. The boolean is
  // stamped whenever the evidence row decided, even by detail text only
  // (pre-push audit P1 on ca460e0f0c). An UNDECIDED row is stamped null
  // rather than left blank: mergeServiceRows lets null through for these
  // two keys, so a priced row the reconciler could not decide never
  // inherits a saved sibling's selection through the label merge.
  const decision = preSlabWarrantyDecision(decided);
  return {
    warrantyTerms: preSlabWarrantyTermsForDecision(decision),
    warrantyExtendedSelected: decision === 'unset' ? null : decision === 'extended',
    warrantyStatus: decision === 'unset' ? null : (cleanText(decided.warrantyStatus) || null),
  };
}

function oneTimeRowsFromPricing(pricingBundle = {}, evidenceGroups = []) {
  const items = Array.isArray(pricingBundle.oneTimeBreakdown?.items)
    ? pricingBundle.oneTimeBreakdown.items
    : [];
  return items
    .filter((item) => item && item.kind !== 'discount' && item.service !== 'waveguard_setup')
    .map((item) => {
      const amount = Number(item.amount ?? item.price);
      const detailParts = [
        cleanText(item.detail),
        item.quoteRequired === true ? 'Quote required' : null,
        Number.isFinite(amount) && amount > 0 ? fmtMoney(amount) : null,
      ].filter(Boolean);
      const evidence = reconcilePricedTrenchingWarrantyEvidence(item, evidenceGroups, pricingBundle, items);
      const preSlabEvidence = reconcilePricedPreSlabWarrantyEvidence(item, evidenceGroups, pricingBundle, items);
      return {
        service: cleanText(item.service || item.serviceKey || item.service_key || item.key) || null,
        label: cleanText(item.label || item.name || item.service || 'One-time service'),
        detail: detailParts.join(' - '),
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        ...(trenchingServiceIdentity(item) === 'termite_trenching'
          ? { purchasedTerms: purchasedTermsForRow(evidence) }
          : {}),
        ...preSlabProjectionFields(item, preSlabEvidence),
        ...(item.isCommercial === true ? { isCommercial: true } : {}),
        oneTime: true,
      };
    });
}

function oneTimeRowsFromResult(result = {}) {
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  // A row mirrored across containers is one job (collapseMirroredRows).
  const items = collapseMirroredRows([
    oneTime.items, oneTime.specItems, nestedOneTime.items, nestedOneTime.specItems, result.specItems,
  ]);
  return items
    .filter((item) => item && item.onProg !== true && item.includedOnProgram !== true)
    .map((item) => ({ item, amount: Number(item.price ?? item.amount ?? item.total) }))
    .filter(({ item, amount }) => {
      const descriptor = cleanText([
        item.kind,
        item.service,
        item.key,
        item.label,
        item.displayName,
        item.name,
      ].filter(Boolean).join(' ')).toLowerCase();
      if (item.service === 'waveguard_setup') return false;
      if (descriptor.includes('discount') || descriptor.includes('savings') || descriptor.includes('credit')) return false;
      if (Number.isFinite(amount) && amount <= 0) return false;
      return true;
    })
    .map(({ item, amount }) => {
      const detailParts = [
        cleanText(item.detail || item.det || item.note),
        item.quoteRequired === true ? 'Quote required' : null,
        Number.isFinite(amount) && amount > 0 ? fmtMoney(amount) : null,
      ].filter(Boolean);
      return {
        service: cleanText(item.service || item.serviceKey || item.service_key || item.key) || null,
        label: cleanText(item.label || item.displayName || item.name || item.service || 'One-time service'),
        detail: detailParts.join(' - '),
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        ...preSlabProjectionFields(item),
        ...(item.isCommercial === true ? { isCommercial: true } : {}),
        oneTime: true,
      };
    });
}

function oneTimeEvidenceGroupsFromEstimateData(estData = {}) {
  const roots = [...new Set([estData.result, estData.engineResult]
    .filter((value) => value && typeof value === 'object'))];
  if (!roots.length) roots.push(estData);
  return roots.map(rawOneTimeWarrantyEvidenceItems);
}

// The saved roots, current first: result, then an older engineResult, else
// the raw save.
function oneTimeRootsFromEstimateData(estData = {}) {
  const roots = [...new Set([estData.result, estData.engineResult]
    .filter((value) => value && typeof value === 'object'))];
  if (!roots.length) roots.push(estData);
  return roots;
}

// The one-time rows on the CURRENT saved root only (no fallback rows).
function currentOneTimeRowsFromEstimateData(estData = {}) {
  return oneTimeRowsFromResult(oneTimeRootsFromEstimateData(estData)[0]);
}

const oneTimeRowScopeKey = (row = {}) => `${cleanText(row.service).toLowerCase()}|${cleanText(row.label).toLowerCase()}`;

function oneTimeRowsFromEstimateData(estData = {}) {
  const roots = oneTimeRootsFromEstimateData(estData);
  const evidenceGroups = oneTimeEvidenceGroupsFromEstimateData(estData);
  const projectedCurrent = oneTimeRowsFromResult(roots[0]);
  // A current pre-slab row takes its decision through the same reconciler
  // the priced rows use (current rows, then itself, then older rows), BEFORE
  // the merge with older rows, so the merge lends nothing the reconciler did
  // not grant (tree-reviewer on #5195).
  const currentRows = projectedCurrent.map((row) => (isPreSlabTreatmentItem(row)
    ? { ...row, ...preSlabProjectionFields(row, reconcilePricedPreSlabWarrantyEvidence(row, evidenceGroups, {}, projectedCurrent)) }
    : row));
  const fallbackRows = roots.slice(1).flatMap(oneTimeRowsFromResult);
  const mergedRows = mergeOneTimeServiceRows(currentRows, fallbackRows);
  return mergedRows.map((row) => {
    if (trenchingServiceIdentity(row) !== 'termite_trenching') return row;
    const evidence = reconcileTrenchingWarrantyEvidence(row, evidenceGroups, mergedRows);
    return { ...row, purchasedTerms: purchasedTermsForRow(evidence) };
  });
}

function frequencyHasRecurringValue(frequency = {}) {
  const monthly = Number(frequency.monthly);
  const annual = Number(frequency.annual);
  const perVisit = Number(frequency.perVisit);
  return (Number.isFinite(monthly) && monthly > 0)
    || (Number.isFinite(annual) && annual > 0)
    || (Number.isFinite(perVisit) && perVisit > 0)
    || (Array.isArray(frequency.included) && frequency.included.length > 0)
    || (Array.isArray(frequency.perServiceTreatments) && frequency.perServiceTreatments.length > 0);
}

function serviceLine(row = {}) {
  const parts = [row.label];
  if (row.cadence) parts.push(row.cadence);
  if (Number.isFinite(row.visitsPerYear) && row.visitsPerYear > 0) {
    parts.push(`${row.visitsPerYear} applications/year`);
  }
  if (Number.isFinite(row.perApplication) && row.perApplication > 0) {
    parts.push(`${fmtMoney(row.perApplication)} per application`);
  }
  if (row.detail) parts.push(row.detail);
  parts.push(...(row.purchasedTerms || []));
  return parts.filter(Boolean).join(' - ');
}

function normalizeFrequencyKey(value) {
  const raw = cleanText(value).toLowerCase().replace(/[_\s-]+/g, '_');
  if (!raw) return null;
  if (raw === 'light' || raw.includes('tree_shrub_light')) return 'light';
  if (raw === 'standard' || raw.includes('tree_shrub_standard')) return 'standard';
  // 'enhanced' is still a live Lawn tier (and a retired T&S tier kept for old data).
  if (raw === 'enhanced' || raw.includes('tree_shrub_enhanced')) return 'enhanced';
  if (raw === '6' || raw.includes('bi_month') || raw.includes('bimonth')) return 'bi_monthly';
  if (raw === '12' || raw.includes('monthly') || raw === 'month') return 'monthly';
  if (raw === '4' || raw.includes('quarter')) return 'quarterly';
  return null;
}

function selectedFrequencyKeyFromEstimateData(estData = {}) {
  const result = estData.result || estData.engineResult || estData || {};
  const inner = result.results && typeof result.results === 'object' ? result.results : {};
  const services = Array.isArray(result.recurring?.services)
    ? result.recurring.services
    : (Array.isArray(inner.recurring?.services) ? inner.recurring.services : []);
  const pestService = services.find((service) => /pest/i.test(cleanText(service?.name || service?.label || service?.service)));
  const treeShrubService = services.find((service) => /tree|shrub|ornamental/i.test(cleanText(service?.name || service?.label || service?.service)));
  const customerSelection = estData.customerSelection
    || result.customerSelection
    || inner.customerSelection
    || {};
  const serviceTierCandidates = [
    customerSelection.serviceTierKey,
    customerSelection.serviceTier,
    customerSelection.tierKey,
    customerSelection.tier,
    treeShrubService?.serviceTierKey,
    treeShrubService?.serviceTier,
    treeShrubService?.tierKey,
    treeShrubService?.tier,
  ];
  for (const candidate of serviceTierCandidates) {
    const key = normalizeFrequencyKey(candidate);
    if (key === 'light' || key === 'standard' || key === 'enhanced') return key;
  }
  const directCandidates = [
    customerSelection.frequencyKey,
    customerSelection.frequency,
    pestService?.frequency,
    pestService?.billing,
    pestService?.cadence,
    pestService?.visitsPerYear,
    pestService?.visits,
    pestService?.apps,
    inner.pest?.frequency,
    inner.pest?.cadence,
    inner.pest?.apps,
    result.recurring?.pestFrequency,
    estData.inputs?.pestFreq,
    estData.engineInputs?.services?.pest?.frequency,
  ];
  for (const candidate of directCandidates) {
    const key = normalizeFrequencyKey(candidate);
    if (key) return key;
  }

  const pestMonthly = Number(pestService?.mo ?? pestService?.monthly);
  const pestTiers = Array.isArray(inner.pestTiers)
    ? inner.pestTiers
    : (Array.isArray(result.pestTiers) ? result.pestTiers : []);
  if (Number.isFinite(pestMonthly) && pestTiers.length) {
    const match = pestTiers.find((tier) => Math.abs(Number(tier?.mo || 0) - pestMonthly) < 0.05);
    const key = normalizeFrequencyKey(match?.label || match?.apps || match?.v);
    if (key) return key;
  }
  return null;
}

function selectPricingFrequency(pricingBundle = {}, estimate = {}, estData = {}, selectedFrequencyKey = '') {
  const frequencies = Array.isArray(pricingBundle.frequencies) ? pricingBundle.frequencies : [];
  if (!frequencies.length) return {};

  const requested = cleanText(selectedFrequencyKey);
  if (requested) {
    const requestedKey = normalizeFrequencyKey(requested);
    const requestedLower = requested.toLowerCase();
    const match = frequencies.find((frequency) => (
      frequency.key === requested
      || (requestedKey && frequency.key === requestedKey)
      || cleanText(frequency.label).toLowerCase() === requestedLower
      || (requestedKey && normalizeFrequencyKey(frequency.label) === requestedKey)
    ));
    if (match) return match;
  }

  const savedMonthly = Number(estimate.monthly_total ?? estimate.monthlyTotal);
  if (Number.isFinite(savedMonthly) && savedMonthly > 0) {
    const best = frequencies
      .map((frequency) => ({ frequency, diff: Math.abs(Number(frequency.monthly || 0) - savedMonthly) }))
      .sort((a, b) => a.diff - b.diff)[0];
    if (best && best.diff < 0.05) return best.frequency;
  }

  const savedAnnual = Number(estimate.annual_total ?? estimate.annualTotal);
  if (Number.isFinite(savedAnnual) && savedAnnual > 0) {
    const best = frequencies
      .map((frequency) => ({ frequency, diff: Math.abs(Number(frequency.annual || 0) - savedAnnual) }))
      .sort((a, b) => a.diff - b.diff)[0];
    if (best && best.diff < 0.05) return best.frequency;
  }

  const key = selectedFrequencyKeyFromEstimateData(estData);
  return frequencies.find((frequency) => frequency.key === key) || frequencies[0];
}

function normalizeFirstVisitFee(fee = {}) {
  const amount = Number(fee.amount ?? fee.price ?? fee.total);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    service: cleanText(fee.service || fee.key) || null,
    label: cleanText(fee.label || fee.name || 'First-visit fee'),
    amount,
    waivedWithPrepay: fee.waivedWithPrepay === true,
  };
}

function firstVisitFeesFromPricing(pricingBundle = {}) {
  const fees = Array.isArray(pricingBundle.firstVisitFees)
    ? pricingBundle.firstVisitFees
    : (pricingBundle.setupFee ? [pricingBundle.setupFee] : []);
  return fees.map(normalizeFirstVisitFee).filter(Boolean);
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function quoteRequiredFromContext(estimate = {}, pricingBundle = {}) {
  const breakdown = pricingBundle.oneTimeBreakdown || {};
  const quoteItems = Array.isArray(breakdown.quoteRequiredItems)
    ? breakdown.quoteRequiredItems
    : (Array.isArray(breakdown.items) ? breakdown.items.filter((item) => item?.quoteRequired === true) : []);
  return pricingBundle.quoteRequired === true
    || breakdown.quoteRequired === true
    || quoteItems.length > 0
    || estimate.quoteRequired === true
    || cleanText(estimate.status) === 'quote_required';
}

// A row's service lanes; a commercial row (isCommercial) reads as its
// commercial lane even where only the saved row carried that marker.
function rowGuaranteeLanes(row = {}) {
  return row.guaranteeLanes
    || (row.isCommercial === true ? guaranteeLanesForRow(row) : serviceKeysFromText(row.service, row.label));
}

const RECURRING_PLAN_TERMS = 'Money-back guarantee on recurring WaveGuard service: free re-treats between visits, and a refund of the most recent service payment if a covered problem can’t be solved.';
const ONE_TIME_CALLBACK_TERMS = 'This one-time service may include a 30-day callback period when shown on the estimate.';

// Whether one row carries the plan terms itself (owner ruling 2026-09-27:
// each service carries its own terms; the page's serviceRowTermsScope):
// residential pest, lawn, mosquito, tree & shrub or palm work, on an
// estimate with no termite, unclassifiable or commercial scope.
function rowCarriesOwnPlanTerms(row, { noGuaranteeClaims = false, commercialScope = false } = {}) {
  if (noGuaranteeClaims === true || commercialScope === true || !row || row.isCommercial === true) return false;
  const lanes = rowGuaranteeLanes(row);
  return lanes.length > 0 && lanes.every((lane) => RECURRING_TERMS_LANES.includes(lane));
}

function assistantGuaranteeContext(noGuaranteeClaims, serviceMode, recurringRows, oneTimeRows, noEstimateWideGuarantee = false) {
  const rowLanes = [...recurringRows, ...oneTimeRows].map((row) => {
    const keys = rowGuaranteeLanes(row);
    return keys.length ? keys : ['unknown'];
  });
  const lanes = [...new Set(rowLanes.flat())];
  // The page's own rule (routes/estimate-public.js estimateCarriesPlanTerms):
  // plan terms cover the estimate when EVERY service carries them, so a pest
  // + lawn bundle carries them, and a rodent, commercial or unknown lane does
  // not. The one-time 30-day callback follows the same scope, except a
  // lawn-only job (the page's oneTimePriceCopy lawn branch).
  // The page's own decision (noEstimateWideGuarantee: an authored proposal or
  // an engine commercial mark the rows here may not show) can only narrow it.
  const everyLaneCarriesTerms = noEstimateWideGuarantee !== true
    && lanes.length > 0 && lanes.every((lane) => RECURRING_TERMS_LANES.includes(lane));
  const recurringTermsEligible = !noGuaranteeClaims && serviceMode === 'recurring'
    && recurringRows.length > 0 && everyLaneCarriesTerms;
  const oneTimePestTerms = !noGuaranteeClaims && serviceMode === 'one_time'
    && everyLaneCarriesTerms && !lanes.every((lane) => lane === 'lawn');
  return {
    noGuaranteeClaims: noGuaranteeClaims === true,
    recurringTermsEligible,
    recurring: recurringTermsEligible ? RECURRING_PLAN_TERMS : null,
    oneTime: oneTimePestTerms ? ONE_TIME_CALLBACK_TERMS : null,
    guidance: noGuaranteeClaims
      ? 'Use this estimate’s written service scope and terms. Do not infer an estimate-wide callback, satisfaction, re-treatment, or money-back guarantee. State each service’s terms exactly as guarantees.serviceTerms lists them.'
      : (recurringTermsEligible ? null : 'Use the service-specific written terms. Do not infer recurring callbacks, money-back, or no-contract terms from membership or category-specific satisfaction wording. State each service’s terms exactly as guarantees.serviceTerms lists them.'),
  };
}

function buildEstimateAssistantContext({
  estimate = {},
  estData = {},
  pricingBundle = {},
  selectedFrequency = '',
  serviceMode = 'recurring',
  noGuaranteeClaims = false,
  noEstimateWideGuarantee = false,
  // An authored proposal or an engine commercial row anywhere
  // (estimateHasCommercialScope): no row carries the plan terms itself.
  commercialScope = false,
} = {}) {
  const parsedData = parseEstimateData(estData);
  const requestedMode = serviceMode === 'one_time' ? 'one_time' : 'recurring';
  const frequency = selectPricingFrequency(pricingBundle, estimate, parsedData, selectedFrequency);
  // The bond selector updates these inputs and mapped stats while historical
  // engineResult rows may remain. Explicit removal must also invalidate their
  // purchased scope, including a frozen pricing row that still shows the bond.
  const rawServices = rawRecurringServiceRows(parsedData);
  const bondSelection = selectedBondTermsFromEstimateData(parsedData, rawServices, frequency);
  const pricingRecurringRows = serviceRowsFromPricing(pricingBundle, frequency, bondSelection.terms);
  const estimateRecurringRows = serviceRowsFromEstimateData(rawServices, bondSelection);
  const recurringServices = mergeServiceRows(
    pricingRecurringRows,
    estimateRecurringRows,
    { allowFallbackOnly: pricingRecurringRows.length === 0 },
  );
  const oneTimeEvidenceGroups = oneTimeEvidenceGroupsFromEstimateData(parsedData);
  const pricedOneTimeRows = oneTimeRowsFromPricing(pricingBundle, oneTimeEvidenceGroups);
  const oneTimeServices = mergeOneTimeServiceRows(
    pricedOneTimeRows,
    oneTimeRowsFromEstimateData(parsedData),
  );
  // Rows still in the current scope: priced now, or on the current saved
  // result. oneTimeRowsFromEstimateData also keeps rows only an older
  // engineResult retains; those were removed and must never be advertised.
  const currentOneTimeKeys = new Set(
    [...pricedOneTimeRows, ...currentOneTimeRowsFromEstimateData(parsedData)].map(oneTimeRowScopeKey),
  );
  const oneTimeTotal = Number(pricingBundle.anchorOneTimePrice || estimate.onetime_total || estimate.onetimeTotal);
  const hasOneTimeValue = (Number.isFinite(oneTimeTotal) && oneTimeTotal > 0) || oneTimeServices.length > 0;
  const hasPricingRecurringValue = Array.isArray(pricingBundle.frequencies)
    && pricingBundle.frequencies.some(frequencyHasRecurringValue);
  const hasRecurringValue = recurringServices.length > 0
    || hasPricingRecurringValue
    || Number(estimate.monthly_total ?? estimate.monthlyTotal) > 0;
  const oneTimeOffered = truthy(estimate.show_one_time_option) || truthy(estimate.showOneTimeOption);
  const structurallyOneTime = hasOneTimeValue && !hasRecurringValue;
  const oneTimeAvailable = oneTimeOffered || structurallyOneTime;
  const selectedMode = (requestedMode === 'one_time' || structurallyOneTime) && oneTimeAvailable
    ? 'one_time'
    : 'recurring';
  const services = selectedMode === 'one_time'
    ? oneTimeServices
    : (recurringServices.length ? recurringServices : (oneTimeAvailable ? oneTimeServices : []));
  // Classify before display-name merging: "Commercial Pest" and "Pest Control"
  // share a short label but must not share recurring residential terms.
  const guarantees = assistantGuaranteeContext(noGuaranteeClaims, selectedMode,
    [...pricingRecurringRows, ...estimateRecurringRows], oneTimeServices, noEstimateWideGuarantee);
  const billingPeriod = periodLabelForFrequency(frequency);
  const billingAmount = billingAmountForFrequency(frequency);
  const serviceCadence = frequency?.billingFrequencyKey && frequency.billingFrequencyKey !== frequency.key
    ? cleanText(frequency.label)
    : null;
  const rawWaveGuardTier = cleanText(pricingBundle.waveGuardTier || estimate.waveguard_tier || estimate.tier || 'WaveGuard');
  const waveGuardTier = /^waveguard\b/i.test(rawWaveGuardTier)
    ? rawWaveGuardTier
    : `WaveGuard ${rawWaveGuardTier}`;
  const annual = Number(frequency.annual || estimate.annual_total || estimate.annualTotal);
  const firstVisitFees = selectedMode === 'one_time' ? [] : firstVisitFeesFromPricing(pricingBundle);
  const setupFee = firstVisitFees.find((fee) => fee.service === 'waveguard_setup') || firstVisitFees[0] || null;
  const firstName = cleanText(estimate.customer_name || estimate.customerName).split(' ')[0]
    || cleanText(estimate.customerFirstName);
  const quoteRequired = quoteRequiredFromContext(estimate, pricingBundle);
  // Expose separately-billed add-ons with their own Ask Waves chip or proven
  // purchased terms even when this recurring estimate offers no one-time plan.
  // The plan selector must not hide the purchased scope of a billed add-on.
  const isAssistantVisibleOneTimeAddOn = (row) => isGermanRoachCleanoutContextRow(row) || isBoraCareContextRow(row)
    || row.purchasedTerms?.length > 0
    // A pre-slab add-on's warranty terms expose it only while it is still
    // in the current scope (Codex #5195 r1: a fallback-only row from an
    // older engineResult is a removed treatment).
    || (row.warrantyTerms?.length > 0 && currentOneTimeKeys.has(oneTimeRowScopeKey(row)));
  const hasAssistantVisibleOneTimeAddOn = oneTimeServices.some(isAssistantVisibleOneTimeAddOn);
  const exposeOneTimeContext = !quoteRequired
    && (oneTimeAvailable || hasAssistantVisibleOneTimeAddOn)
    && (hasOneTimeValue || oneTimeServices.length > 0);
  const oneTimeContextAmount = Number.isFinite(oneTimeTotal) && oneTimeTotal > 0 ? oneTimeTotal : null;
  const invoiceMode = truthy(estimate.bill_by_invoice) || truthy(estimate.billByInvoice);
  const normalBillingAmountText = billingAmount ? `${fmtMoney(billingAmount)} / ${billingPeriod}` : null;
  const oneTimeBillingAmount = Number.isFinite(oneTimeTotal) && oneTimeTotal > 0 ? oneTimeTotal : null;
  const contextBillingAmount = selectedMode === 'one_time' ? oneTimeBillingAmount : billingAmount;
  const invoiceAmount = selectedMode === 'one_time'
    ? oneTimeTotal
    : (billingAmount || Math.round(Number(frequency.monthly || estimate.monthly_total || estimate.monthlyTotal || 0) * 3 * 100) / 100);
  const contextBillingText = selectedMode === 'one_time'
    ? (oneTimeBillingAmount ? fmtMoney(oneTimeBillingAmount) : null)
    : normalBillingAmountText;
  // Each service keeps its own terms: a row that carries the plan terms
  // itself keeps them in its detail even where the estimate as a whole
  // does not. The detail is filtered by the page's shared scope rule
  // (withoutClaimsOutsideScope): 'none' on a no-guarantee estimate, 'all'
  // for a row that carries the plan terms, else 'satisfaction', where only
  // "satisfaction guaranteed" survives and a generic written guarantee or
  // warranty claim is dropped as the page drops it (pre-push audit P1 on
  // d1da03b391). A pre-slab job's selected extended warranty is verified
  // purchased coverage and is kept, as on the page.
  const rowWithSummary = (row) => {
    const rowScope = noGuaranteeClaims ? 'none'
      : (guarantees.recurringTermsEligible || rowCarriesOwnPlanTerms(row, { commercialScope }) ? 'all' : 'satisfaction');
    const detail = rowScope === 'all' ? row.detail
      : withoutClaimsOutsideScope(cleanText(row.detail), rowScope, preSlabSelectedWarrantyPart(row));
    // Null warranty keys carried for the merge are not served.
    const { warrantyExtendedSelected: _flag, warrantyStatus: _status, ...served } = row;
    const projectedRow = {
      ...served,
      ...(typeof row.warrantyExtendedSelected === 'boolean' ? { warrantyExtendedSelected: row.warrantyExtendedSelected } : {}),
      ...(cleanText(row.warrantyStatus) ? { warrantyStatus: cleanText(row.warrantyStatus) } : {}),
    };
    const safeRow = quoteRequired
      ? {
          ...projectedRow,
          monthly: null,
          perApplication: null,
          amount: null,
          detail: cleanText(detail).replace(/\$[\d,]+(?:\.\d{1,2})?/g, 'price pending inspection'),
        }
      : { ...projectedRow, detail };
    return {
      ...safeRow,
      summary: serviceLine(safeRow),
    };
  };
  const servicesContext = services.map(rowWithSummary);
  const recurringServicesContext = recurringServices.map(rowWithSummary);
  // When one-time work is not offered and an add-on alone exposes this
  // context, only the add-ons are exposed: the merged list also retains
  // rows only an older engineResult still carries (a removed termite-foam
  // treatment), and those must not ride along (pre-push audit P1 on
  // 5e030feff6).
  const exposedOneTimeServices = oneTimeAvailable
    ? oneTimeServices
    : oneTimeServices.filter(isAssistantVisibleOneTimeAddOn);
  const oneTimeItemsContext = exposeOneTimeContext ? exposedOneTimeServices.map(rowWithSummary) : null;

  return {
    company: COMPANY,
    customerFirstName: firstName || null,
    address: cleanText(estimate.address) || null,
    status: cleanText(estimate.status) || null,
    serviceMode: selectedMode,
    waveGuardTier,
    billing: {
      amount: quoteRequired ? null : contextBillingAmount,
      amountText: quoteRequired ? null : contextBillingText,
      period: quoteRequired ? null : (selectedMode === 'one_time' ? 'one-time' : billingPeriod),
      serviceCadence: quoteRequired || selectedMode === 'one_time' ? null : serviceCadence,
      monthlyText: quoteRequired || selectedMode === 'one_time' || !frequency.monthly ? null : `${fmtMoney(frequency.monthly)} / month equivalent`,
      annualText: !quoteRequired && selectedMode !== 'one_time' && Number.isFinite(annual) && annual > 0 ? fmtMoney(annual) : null,
      billedAfterVisit: !invoiceMode && !quoteRequired && selectedMode !== 'one_time',
      invoiceMode,
      invoiceDueText: invoiceMode && !quoteRequired && Number.isFinite(invoiceAmount) && invoiceAmount > 0
        ? fmtMoney(invoiceAmount)
        : null,
      quoteRequired,
    },
    services: servicesContext,
    recurringServices: recurringServicesContext,
    setupFee,
    firstVisitFees,
    // Identity-only (no amounts) quote-required one-time rows that the
    // one-time block above hides, so a recurring-mode quote that also carries a
    // lead-only line (e.g. mosquito_misting_system) still knows it's there.
    quoteOnlyItems: quoteRequired && !exposeOneTimeContext
      ? oneTimeServices.map((row) => ({ service: row.service || row.key || null, label: row.label || row.name || null }))
      : [],
    oneTime: exposeOneTimeContext ? {
      amount: oneTimeContextAmount,
      amountText: oneTimeContextAmount ? fmtMoney(oneTimeContextAmount) : null,
      items: oneTimeItemsContext,
    } : null,
    // Without estimate-wide terms, each service's own terms, listed once for
    // the model and the fallback alike.
    guarantees: guarantees.recurringTermsEligible
      ? guarantees
      : {
        ...guarantees,
        serviceTerms: serviceTermsFromRows(
          [
            servicesContext, recurringServicesContext, oneTimeItemsContext || [],
            // Termite rows the display merge left out (a raw engine row behind
            // a frozen pest projection) still state their own terms.
            estimateRecurringRows.filter((row) => (row.guaranteeLanes || []).some((lane) => TERMITE_LANES.has(lane))
              && !recurringServices.some((merged) => merged.label === row.label)),
          ],
          oneTimeItemsContext || [],
          {
            // A row that carries the plan terms itself states them under its
            // own name: the recurring terms on a recurring plan, or the
            // callback period on one-time work other than lawn.
            ownTerms: (row) => {
              if (!rowCarriesOwnPlanTerms(row, { noGuaranteeClaims, commercialScope })) return [];
              if (row.oneTime === true) {
                return rowGuaranteeLanes(row).every((lane) => lane === 'lawn') ? [] : [ONE_TIME_CALLBACK_TERMS];
              }
              return selectedMode === 'recurring' ? [RECURRING_PLAN_TERMS] : [];
            },
          },
        ),
      },
    contact: COMPANY,
  };
}

function listServices(context = {}) {
  const serviceRows = Array.isArray(context.services) ? context.services : [];
  const oneTimeRows = Array.isArray(context.oneTime?.items) ? context.oneTime.items : [];
  // Append separately-billed one-time add-ons (e.g. Bora-Care) that aren't already
  // in the service list, deduped, so "what's included?" lists them too. For a
  // one-time estimate context.services already equals these rows, so the dedup
  // keeps the list unchanged.
  const keyOf = (row) => `${String(row?.service || '').toLowerCase()}|${String(row?.label || row?.name || '').toLowerCase()}`;
  const seen = new Set(serviceRows.map(keyOf));
  const extraOneTime = oneTimeRows.filter((row) => !seen.has(keyOf(row)));
  const rows = [...serviceRows, ...extraOneTime];
  if (!rows.length) return 'I do not see a detailed service list on this estimate.';
  return rows.map((row) => row.summary || serviceLine(row)).filter(Boolean).join('\n');
}

function supportRows(context = {}) {
  const support = context.supportContext || context.aiSupport || {};
  return [
    ...(Array.isArray(support.serviceLibrary) ? support.serviceLibrary : []),
    ...(Array.isArray(support.productCatalog) ? support.productCatalog : []),
    ...(Array.isArray(support.knowledgeBase) ? support.knowledgeBase : []),
    ...(Array.isArray(support.agronomicWiki) ? support.agronomicWiki : []),
    ...(Array.isArray(support.repositoryFiles) ? support.repositoryFiles : []),
  ];
}

function supportRowMatchesQuestion(row = {}, question = '') {
  const text = cleanText([
    row.title,
    row.path,
    row.category,
    row.snippet,
    ...(Array.isArray(row.products) ? row.products : []),
  ].filter(Boolean).join(' ')).toLowerCase();
  const terms = cleanText(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4 && !['what', 'when', 'does', 'each', 'visit', 'safe', 'kids', 'pets', 'product', 'products'].includes(term));
  return !terms.length || terms.some((term) => text.includes(term));
}

// Both the active-ingredient sentence and the label-facts line answer from
// the SAME scoped row set (scopeCatalogRowsToQuestion below) — a targeted
// question must not name one product's ingredient while quoting another's
// label, and a question with no attributable product names nothing.
function activeIngredientsFromSupport(context = {}, question = '') {
  const catalogRows = supportRows(context)
    .filter((row) => row.source === 'admin_product_catalog');
  const scoped = scopeCatalogRowsToQuestion(catalogRows, context, question);
  const ingredients = scoped.map((row) => row.activeIngredient).filter(Boolean);
  return [...new Set(ingredients.map(cleanText).filter(Boolean))].slice(0, 8);
}

// Safety/product questions with support rows never reach the live models —
// they force-route to the deterministic fallback so answers only ever quote
// reviewed label facts. water/irrigat/sprinkl and the rainfast phrasings are
// here for the same reason: the label watering guidance and rainfast window
// live in the fallback's safety branch, so "when can I run the sprinklers?"
// or "what if it rains after treatment?" must not go to an LLM that could
// miss or hallucinate them. Bare "rain"/"treatment" deliberately do NOT
// trigger: "will you still come if it rains?" is a scheduling question and
// "how long does the treatment last?" is a duration question — both belong
// on the normal path, not in safety copy.
// water(?:ing|ed|s)? with the (?!\s+bugs?\b) lookahead instead of water\w*:
// "water bugs" is a PEST, not a watering question, and must keep its
// pest-branch answer. The rain-after alternates are anchored to treatment
// vocabulary and accept BOTH word orders — "what if it rains after
// treatment?" and "how soon after my lawn service can it rain?" are the
// same label question — but "will you still come if it rains after 2pm?"
// is scheduling and must stay on the normal path.
// "water" alternates are irrigation-anchored: watering-context wording
// ("water the lawn", "how soon can I water") routes here, but "standing
// water" (mosquito breeding) and "keep mosquitoes off" (efficacy) are
// service questions and stay on the normal path. keep-off is restricted to
// people/pets — that's re-entry wording.
const FORCE_FALLBACK_QUESTION_PATTERN = /\b(safe|pets?|dogs?|cats?|kids?|child|children|precautions?|chemical|product|products|spray|label|applied|application|lawn|turf|weed|fungus|fertil|pest|roach(?:es)?|cockroach(?:es)?|ants?|spider|inside|interior|outside|exterior|irrigat\w*|sprinkl\w*|rain[-\s]?fast|rain[-\s]?proof|re-?ent(?:er|ry|ering)\w*|dry|dries|dried|drying)\b|\bkeep\s+(?:people|pets?|kids?|children|dogs?|cats?|everyone|family)\s+off\b|\bkeep\s+off\b|\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)(?=[^.?!]{0,40}\b(?:after|before|until|lawn|turf|grass|yard|plants?|treat\w*|appl\w*|spray\w*|dry|dries|dried)\b)|\b(?:after|before|until|once|when|how\s+soon|how\s+long)\b[^.?!]{0,40}\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)|\brains?\s+(?:right\s+)?after\s+(?:(?:the|my|a|an|our|your|you|we)\s+)?(?:(?:lawn|turf|grass|yard|pest|bug|mosquito|termite|rodent|flea|tick|tree|shrub|weed|fungus|perimeter|barrier|care|control|quarterly|monthly|first|next|initial)\s+){0,3}(?:treat\w*|appl\w*|spray\w*|services?|visits?)\b|\bafter\s+(?:(?:the|my|a|an|our|your|you|we)\s+)?(?:(?:lawn|turf|grass|yard|pest|bug|mosquito|termite|rodent|flea|tick|tree|shrub|weed|fungus|perimeter|barrier|care|control|quarterly|monthly|first|next|initial)\s+){0,3}(?:treat\w*|appl\w*|spray\w*|services?|visits?)\b[^.?!]{0,40}\brains?\b|\b(?:treat|appl|spray)\w*\b[^.?!]{0,40}\bafter\s+(?:it\s+|the\s+)?rains?\b|\brain\s+wash\w*\b/i;

// Generic treatment vocabulary says nothing about WHICH product a question
// targets, so it never counts as naming one.
// Broad product-category nouns ("the herbicide") — weaker targeting than a
// product name; shared by category coordination, adjectival scoping, and the
// unresolved-product guard.
const CATEGORY_NOUNS = '(?:herbicides?|insecticides?|fungicides?|termiticides?|rodenticides?|fertilizers?|adjuvants?|baits?|igrs?|growth\\s+regulators?)';

const GENERIC_QUESTION_TERMS = new Set([
  'what', 'when', 'does', 'each', 'visit', 'safe', 'kids', 'pets', 'product', 'products',
  'spray', 'sprays', 'sprayed', 'treatment', 'treatments', 'treated', 'chemical', 'chemicals',
  'application', 'applications', 'applied', 'service', 'services', 'yard', 'home', 'house',
  'area', 'areas', 'okay', 'after', 'before', 'around', 'inside', 'outside', 'water', 'long',
  'active', 'ingredient', 'ingredients',
  // bug/insect wording is family vocabulary, not a product name — and
  // "insect" substring-matches the insecticide CATEGORY, which would let
  // "lawn insect" questions mention-match pest products before family
  // scoping runs. Saying "insecticide" itself still counts as a mention.
  'bugs', 'insect', 'insects',
]);

function questionTermsForMatching(question = '') {
  return cleanText(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4 && !GENERIC_QUESTION_TERMS.has(term));
}

// Taxonomy rank markers inside expanded biological actives ("Bacillus
// thuringiensis subsp. israelensis") — dropped before acronym generation so
// "subsp." never breaks the initials customers actually use.
const TAXONOMY_RANK_TOKENS = new Set(['subsp', 'subspecies', 'ssp', 'spp', 'var', 'strain', 'serotype', 'sp']);

// Tokens with which the question names this SPECIFIC product: the product
// name (via the builder-stamped questionNameTokens — each one is a word the
// customer already typed, so the name itself never rides along in the row)
// or an active ingredient. Title and snippet are deliberately excluded:
// every catalog row's title reads "<category> active ingredient", and
// snippet would let generic re-entry copy ("...sprays have dried") match.
// Callers group naming signals BY TOKEN: several rows can share one active
// ("2,4-D" appears in multiple herbicides) and one on-estimate row
// satisfies that token, while a token whose rows are all off-estimate means
// the customer named a product this estimate does not carry.
function catalogRowNamingTokens(row = {}, question = '') {
  const tokens = [];
  if (row.questionNameMatch === true) {
    tokens.push(...(Array.isArray(row.questionNameTokens) && row.questionNameTokens.length
      ? row.questionNameTokens
      : ['__name__'])); // pre-token contexts: one shared name group
  }
  const ingredientText = cleanText(row.activeIngredient || '').toLowerCase();
  if (!ingredientText) return [...new Set(tokens)];
  for (const term of questionTermsForMatching(question)) {
    if (ingredientText.includes(term)) tokens.push(term);
  }
  // Short/punctuated active-ingredient names ("2,4-D", "Bti") never survive
  // the >=4-char term filter above — compare whole normalized question words
  // against normalized ingredient aliases by exact equality instead.
  // Ingredient lists separate aliases with +, /, ; or "and" — NOT comma,
  // which is part of names like 2,4-D.
  // A short active stored inside a longer salt/ester form ("2,4-D
  // dimethylamine salt") never equals the whole normalized segment, so each
  // segment's DISTINCTIVE words (digit-bearing or >=5 chars — "24d",
  // "dimethylamine", never everyday-short "salt") count as aliases too.
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliasSegments = cleanText(row.activeIngredient || '').split(/[+/;]|\band\b/i);
  const aliases = aliasSegments
    .map(normalize)
    .filter((alias) => alias.length >= 2);
  const aliasWords = aliasSegments
    .flatMap((segment) => segment.split(/\s+/))
    .map(normalize)
    .filter((word) => word.length >= 2 && (/\d/.test(word) || word.length >= 5));
  // Expanded actives answer to their initials ("Bti" for Bacillus
  // thuringiensis israelensis): every >=3-char PREFIX acronym of a
  // segment's words counts, so trailing formulation words ("... solids")
  // don't break the match.
  const acronyms = aliasSegments
    .map((segment) => segment.split(/\s+/)
      .map(normalize)
      .filter((word) => word.length >= 1 && !TAXONOMY_RANK_TOKENS.has(word)))
    .filter((words) => words.length >= 3)
    .flatMap((words) => words.slice(2).map((_, index) => words.slice(0, index + 3).map((word) => word[0]).join('')))
    .filter((acronym) => acronym.length >= 3);
  const comparable = [...aliases, ...aliasWords, ...acronyms];
  if (comparable.length) {
    const questionWords = cleanText(question).split(/\s+/).map(normalize).filter(Boolean);
    for (const word of questionWords) {
      if (comparable.includes(word)) tokens.push(word);
    }
  }
  return [...new Set(tokens)];
}

function catalogRowNamesProduct(row = {}, question = '') {
  return catalogRowNamingTokens(row, question).length > 0;
}

// True when the question names this row's broad CATEGORY ("the herbicide",
// "the insecticide") — weaker targeting than naming the product, so callers
// intersect these with any named families instead of trusting them alone.
function catalogRowMentionsCategory(row = {}, question = '') {
  const text = cleanText([row.category, row.path].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return false;
  if (questionTermsForMatching(question).some((term) => text.includes(term))) return true;
  // Short category acronyms (IGR, PGR — both live catalog categories) never
  // survive the >=4-char term filter — compare 3-char question tokens
  // against whole category words by plural-tolerant equality instead.
  const shortTokens = cleanText(question).toLowerCase().split(/[^a-z0-9]+/)
    .filter((token) => token.length === 3);
  if (!shortTokens.length) return false;
  const categoryWords = text.split(/[^a-z0-9]+/).filter(Boolean);
  return shortTokens.some((token) => categoryWords.includes(token) || categoryWords.includes(`${token}s`));
}

// Scope targeted questions to the product(s) they target — the support
// context is built from ALL estimate services (and the catalog search can
// pull rows that aren't on this estimate at all, e.g. every herbicide when
// the question says "herbicide"), so the wrong product's label facts must
// never answer for another. Attribution = the serviceKeys each row carries
// from the service library's default_products linkage.
// Targeting precedence, most specific first:
//   1. Explicit product mention ("is bifenthrin safe?", "is the 2,4-D lawn
//      spray safe?") — narrows to the mentioned row(s) that are ALSO
//      attributed to this estimate's services; a mentioned row we can't tie
//      to the estimate is not "your product" and fails closed.
//   2. Named service families ("the lawn and mosquito treatments") — rows
//      attributed to ANY named family AND on this estimate; unattributed
//      rows fail closed even on a single-family estimate, and asking about
//      a family the estimate doesn't include ("is the mosquito spray safe?"
//      on a lawn-only estimate) quotes nothing — the question terms can pull
//      that family's products into the support context, but the customer
//      didn't buy them.
//   3. Nothing targeted ("is it pet safe?") — prefer estimate-attributed
//      rows when any exist, otherwise keep every row (linkage can be sparse
//      for peripheral services and a generic question is answerable from
//      whatever the estimate loaded).
// No survivors = an empty set (callers fail closed to generic copy) rather
// than the wrong treatment's rows.
// Families of what the customer is actually LOOKING AT: in one-time mode the
// recurring alternative still rides along in context.recurringServices, but
// its products must not answer for the selected one-time service.
function estimateFamiliesForScoping(context = {}) {
  if (cleanText(context.serviceMode).toLowerCase() === 'one_time') {
    return serviceKeysFromContext({
      services: context.services,
      oneTime: context.oneTime,
    }, '');
  }
  return serviceKeysFromContext(context, '');
}

function scopeCatalogRowsToQuestion(rows, context = {}, question = '') {
  if (!rows.length) return rows;
  const estimateFamilies = estimateFamiliesForScoping(context);
  const attributedTo = (row, families) => Array.isArray(row.serviceKeys)
    && row.serviceKeys.some((key) => families.includes(key));
  const onEstimate = (row) => (estimateFamilies.length
    ? attributedTo(row, estimateFamilies)
    : (Array.isArray(row.serviceKeys) && row.serviceKeys.length > 0));
  const questionFamilies = serviceFamiliesFromText(question);
  // Named rows are tracked BEFORE the on-estimate filter: a customer naming
  // an off-estimate product ("is glyphosate safe?" on a Quinclorac lawn
  // plan) must fail closed to generic copy, not fall through to the
  // estimate's own products' facts.
  const namingTokensByRow = new Map(rows.map((row) => [row, catalogRowNamingTokens(row, question)]));
  const namedRows = rows.filter((row) => namingTokensByRow.get(row).length > 0);
  const productMentions = namedRows.filter(onEstimate);
  // The customer named a product and NONE of the named rows are on this
  // estimate: fail closed outright. Category words in the same breath ("is
  // glyphosate HERBICIDE safe?") describe that product — they must not fall
  // through to the estimate's own products' facts.
  if (namedRows.length && !productMentions.length) return [];
  // EVERY named product must resolve to an on-estimate row: "are 2,4-D and
  // glyphosate safe?" on a 2,4-D-only plan must not answer with the 2,4-D
  // facts alone as though the answer covered both. Naming signals group by
  // the question token that matched — several rows can share one active and
  // one on-estimate row satisfies that token — and a token whose rows are
  // ALL off-estimate fails the whole question closed.
  const coveredTokens = new Set(productMentions.flatMap((row) => namingTokensByRow.get(row)));
  const namedTokens = namedRows.flatMap((row) => namingTokensByRow.get(row));
  if (namedTokens.some((token) => !coveredTokens.has(token))) return [];
  // A product-looking word that resolves to NO loaded row means the
  // customer named a product the catalog does not carry at all — the
  // dedicated named-product fetch would have loaded any catalog match.
  // Answering from the estimate's own rows would read as covering it: fail
  // closed. Two ANCHORED detections keep ordinary nouns out:
  //   1. Coordinated with a RESOLVED product mention ("2,4-D and Roundup")
  //      — "safe for kids and adults" names no product on either side.
  //   2. A LONE mention in product-ask position ("Is Roundup safe for
  //      pets?", "do you use Roundup?") — "is it safe for my golden
  //      retriever" has no candidate in the subject slot.
  const resolvedTokens = new Set(namedTokens.filter((token) => token !== '__name__'));
  const normalizeWord = (word) => word.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const questionWordList = cleanText(question).replace(/&/g, ' and ').split(/\s+/).map(normalizeWord).filter(Boolean);
  const looksLikeUnresolvedProduct = (word) => Boolean(word)
    && (word.length >= 5 || /\d/.test(word))
    && !resolvedTokens.has(word)
    && !GENERIC_QUESTION_TERMS.has(word)
    && !new RegExp(`^${CATEGORY_NOUNS}$`, 'i').test(word)
    && !/^(?:lawns?|turf|grass|weeds?|pest\w*|mosquito\w*|termite\w*|rodent\w*|trees?|shrubs?|ornamentals?|palms?|roach\w*|cockroach\w*|ants?|spiders?|fleas?|ticks?|bees?|wasps?|treat\w*|sprays?|services?|products?|chemicals?|pesticides?|barriers?|granul\w*|dunks?|tablets?|stations?|traps?|concentrates?|liquids?|waveguard)$/.test(word);
  if (resolvedTokens.size) {
    const CONJUNCTION_WORDS = new Set(['and', 'plus', 'or']);
    const SKIPPABLE_ARTICLES = new Set(['the', 'my', 'our', 'a', 'an', 'this', 'that', 'other']);
    for (let i = 0; i < questionWordList.length; i += 1) {
      if (!CONJUNCTION_WORDS.has(questionWordList[i])) continue;
      const leftWord = i > 0 ? questionWordList[i - 1] : '';
      let j = i + 1;
      while (j < questionWordList.length && SKIPPABLE_ARTICLES.has(questionWordList[j])) j += 1;
      const rightWord = j < questionWordList.length ? questionWordList[j] : '';
      if ((resolvedTokens.has(leftWord) && looksLikeUnresolvedProduct(rightWord))
        || (resolvedTokens.has(rightWord) && looksLikeUnresolvedProduct(leftWord))) {
        return [];
      }
    }
  }
  // A pre-token flag match ('__name__') can't say WHICH question word named
  // its row — the lone-mention scan would misread that word as unresolved,
  // so it only runs when every name match is tokenized (the builder always
  // stamps tokens; only legacy/hand-built contexts lack them).
  if (!namedTokens.includes('__name__')) {
    const normalizedQuestion = ` ${questionWordList.join(' ')} `;
    for (const word of new Set(questionWordList)) {
      if (!looksLikeUnresolvedProduct(word)) continue;
      // Auxiliary shapes keep the product in ask position: "will Roundup BE
      // safe?", "would Roundup be safe?" — the optional be/being/stay/remain
      // link covers them without loosening the safety-adjective anchor.
      const askSubject = new RegExp(`\\b(?:is|are|was|were|will|would|can|could|should|might|do|does)\\s+(?:the\\s+|my\\s+|our\\s+|a\\s+|an\\s+|any\\s+)?${word}\\s+(?:be\\s+|being\\s+|stay\\s+|remain\\s+)?(?:safe|ok|okay|toxic|dangerous|harmful|poisonous)\\b`, 'i');
      const askUsage = new RegExp(`\\b(?:use|uses|used|using|sprayed|spraying|applied|applying)\\s+(?:the\\s+|any\\s+)?${word}\\b`, 'i');
      // Passive/product-subject usage puts the product BEFORE the verb:
      // "will Roundup be used on my lawn?", "is Roundup being sprayed?",
      // "Roundup was applied last visit". The product-ask anchors above only
      // see verb-then-product order, so without this the question falls
      // through to the scoped family rows and their facts read as covering
      // the off-catalog name.
      const askPassiveUsage = new RegExp(`\\b${word}\\s+(?:will\\s+|would\\s+|going\\s+to\\s+)?(?:be|being|is|are|was|were|gets?|got)\\s+(?:being\\s+)?(?:used|sprayed|applied|put)\\b`, 'i');
      if (askSubject.test(normalizedQuestion) || askUsage.test(normalizedQuestion) || askPassiveUsage.test(normalizedQuestion)) return [];
    }
  }
  const categoryMentions = rows.filter((row) => catalogRowMentionsCategory(row, question) && onEstimate(row));
  if (namedRows.length || categoryMentions.length) {
    const questionText = cleanText(question);
    // When the customer NAMED a product, a category word in the same breath
    // ("is the 2,4-D herbicide safe?") is adjectival — it describes that
    // product, so sibling on-estimate rows of the category must not ride
    // along and quote label facts for products the customer did not ask
    // about. Category rows join a named product only when a conjunction
    // makes the category its own subject ("2,4-D and the other herbicides"),
    // in either order — mirroring the family coordination below.
    const coordinatesOntoCategory = new RegExp(`\\b(?:and|plus|&|along with|as well as)\\s+(?:the\\s+|my\\s+|our\\s+|other\\s+|any\\s+)*${CATEGORY_NOUNS}\\b`, 'i').test(questionText)
      || new RegExp(`\\b${CATEGORY_NOUNS}\\s+(?:and|plus|&|along with|as well as)\\b`, 'i').test(questionText);
    // Broad category mentions ("the lawn insecticide") can match every
    // on-estimate row of that category — when a family word ADJECTIVALLY
    // qualifies the category, they must stay inside that family. But a
    // family that is only its own COORDINATED subject ("the herbicide and
    // mosquito treatment") does not constrain the category: intersecting
    // herbicides with mosquito would empty the set and starve both answers.
    const familyAdjacentToCategory = new RegExp(`\\b(?:lawn|turf|grass|pest|mosquito|termite|rodent|tree|shrub)\\w*\\s+${CATEGORY_NOUNS}`, 'i').test(questionText);
    const scopedCategory = (namedRows.length && !coordinatesOntoCategory)
      ? []
      : (questionFamilies.length && (familyAdjacentToCategory || !coordinatesOntoCategory)
        ? categoryMentions.filter((row) => attributedTo(row, questionFamilies))
        : categoryMentions);
    // A COORDINATED question ("is Bifenthrin AND the lawn treatment safe?",
    // "the lawn treatment PLUS Bifenthrin") asks about both the named
    // product and the named family — union them. The conjunction must join
    // family/treatment wording on EITHER side: "safe for kids and pets" is
    // not a product+family coordination, and without one the family word is
    // adjectival ("the 2,4-D lawn spray") so the explicit product stays the
    // narrower, correct scope. service(?!\s+dog/animal): "safe for kids and
    // service dog" is a RECIPIENT list, not coordination onto the service.
    const coordinatesOntoFamily = /\b(?:and|plus|&|along with|as well as)\s+(?:the\s+|my\s+|our\s+)?(?:lawn\w*|turf|grass|pest\w*|mosquito\w*|termite\w*|rodent\w*|trees?|shrubs?|roach\w*|cockroach\w*|ants?|spiders?|perimeter|treat\w*|spray\w*|service(?!\s+(?:dogs?|animals?)))\b/i.test(questionText)
      || /\b(?:lawn\w*|turf|grass|pest\w*|mosquito\w*|termite\w*|rodent\w*|trees?|shrubs?|roach\w*|cockroach\w*|ants?|spiders?|perimeter|treat\w*|spray\w*|service(?!\s+(?:dogs?|animals?)))\s+(?:and|plus|&|along with|as well as)\b/i.test(questionText);
    // Category mentions coordinate onto families too: "the herbicide and
    // mosquito treatment" asks about both, and without the union the
    // category branch would return no mosquito facts at all.
    const coordinatedFamilyRows = ((productMentions.length || categoryMentions.length) && questionFamilies.length && coordinatesOntoFamily)
      ? rows.filter((row) => attributedTo(row, questionFamilies) && onEstimate(row))
      : [];
    return [...new Set([...productMentions, ...scopedCategory, ...coordinatedFamilyRows])];
  }
  if (questionFamilies.length) {
    return rows.filter((row) => attributedTo(row, questionFamilies) && onEstimate(row));
  }
  const attributed = rows.filter(onEstimate);
  return attributed.length ? attributed : rows;
}

// Deterministic label-safety line for the forced-fallback safety answer, built
// from the label-verified catalog rows estimate-ai-context attaches. Safety
// questions never reach the live models (the force-fallback gate below), so
// these reviewed label facts must surface here or nowhere. Fail closed: only
// rows estimate-ai-context marked labelVerified carry these fields at all.
// Applicator PPE is deliberately excluded — it is what the technician wears,
// and in a customer answer it reads as customer instructions.
function labelSafetyFactsFromSupport(context = {}, question = '') {
  // Scope over ALL catalog rows first, then keep only verified survivors —
  // if the question names a product whose row is unverified, the answer must
  // carry NO label facts, not another (verified) product's facts. scopedRows
  // (verified or not) stays around as the denominator for the rainfast
  // completeness check below.
  const catalogRows = supportRows(context)
    .filter((row) => row.source === 'admin_product_catalog');
  const scopedRows = scopeCatalogRowsToQuestion(catalogRows, context, question);
  const scoped = scopedRows.filter((row) => row.labelVerified);
  if (!scoped.length) return '';
  const reentries = [...new Set(scoped.map((row) => cleanText(row.reentry || '')).filter(Boolean))];
  const signalWords = [...new Set(scoped.map((row) => cleanText(row.signalWord || '')).filter(Boolean))];
  const rainfast = scoped
    .map((row) => Number(row.rainfastMinutes))
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0);
  const irrigation = [...new Set(scoped.map((row) => cleanText(row.irrigationNotes || '')).filter(Boolean))];
  const parts = [];
  // Every fact line below carries the same completeness rule as the rainfast
  // claim: the copy reads as covering the whole treatment, so the blanket
  // form may only be used when EVERY scoped product (verified or not, hence
  // scopedRows not scoped — unverified rows never carry the field) states the
  // fact AND the catalog slice wasn't truncated at a row cap. A truncated
  // slice can't prove completeness — an omitted product may carry a longer
  // re-entry interval, a harsher signal word, or contrary watering guidance —
  // so the qualified variants say what is and is not on file.
  const catalogTruncated = (context.supportContext || context.aiSupport || {}).productCatalogTruncated === true;
  const coversEveryScopedRow = (field) => !catalogTruncated
    && scoped.filter((row) => cleanText(row[field] || '')).length === scopedRows.length;
  if (reentries.length) {
    const listed = reentries.map((text) => text.replace(/\.$/, '')).join('; ');
    if (coversEveryScopedRow('reentry')) {
      parts.push(reentries.length === 1
        ? `Label re-entry guidance: ${listed}.`
        : `Label re-entry guidance by product: ${listed}.`);
    } else {
      parts.push(reentries.length === 1
        ? `Where a product label provides re-entry guidance: ${listed}; not every product on this estimate has re-entry guidance on file.`
        : `Where product labels provide re-entry guidance, by product: ${listed}; not every product on this estimate has re-entry guidance on file.`);
    }
  }
  if (signalWords.length) parts.push(`Label signal word${signalWords.length > 1 ? 's' : ''}${coversEveryScopedRow('signalWord') ? '' : ' for the products on file'}: ${signalWords.join(', ')}.`);
  // Multiple products: quote the longest (most conservative) window. The
  // label seed intentionally leaves rainfast blank where the label doesn't
  // state a window, so one product's window must not become a claim about
  // the rest.
  if (rainfast.length === scopedRows.length && rainfast.length && !catalogTruncated) {
    parts.push(`Treated areas are rainfast in about ${Math.max(...rainfast)} minutes.`);
  } else if (rainfast.length) {
    parts.push(`Where a product label states a rainfast window, treated areas are rainfast in about ${Math.max(...rainfast)} minutes; not every product on this estimate has a stated window on file.`);
  }
  if (irrigation.length) {
    const listed = irrigation.map((text) => text.replace(/\.$/, '')).join('; ');
    if (coversEveryScopedRow('irrigationNotes')) {
      parts.push(irrigation.length === 1
        ? `Label watering/irrigation guidance: ${listed}.`
        : `Label watering/irrigation guidance by product: ${listed}.`);
    } else {
      parts.push(irrigation.length === 1
        ? `Where a product label provides watering/irrigation guidance: ${listed}; not every product on this estimate has watering guidance on file.`
        : `Where product labels provide watering/irrigation guidance, by product: ${listed}; not every product on this estimate has watering guidance on file.`);
    }
  }
  return parts.join(' ');
}

function summarizeSupportContext(context = {}, question = '') {
  return supportRows(context)
    .filter((row) => supportRowMatchesQuestion(row, question))
    .map((row) => row.snippet || row.title)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

function isGermanRoachCleanoutContextRow(row = {}) {
  const service = cleanText(row.service || row.key).toLowerCase();
  if (service === 'german_roach') return true;
  if (service === 'pest_initial_roach') return false;
  const text = cleanText([row.label, row.detail, row.summary].filter(Boolean).join(' '))
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  // Both clauses must hold: the row must mention roaches AND be a cleanout.
  // `\bclean\s*out\b` matches "cleanout" and "clean out" in one pattern, so the
  // roach `&&` gate can't be bypassed by a non-roach cleanout row.
  return /\broach(?:es)?\b/.test(text) && /\bclean\s*out\b/.test(text);
}

function isBoraCareContextRow(row = {}) {
  const service = cleanText(row.service || row.key).toLowerCase();
  if (service === 'bora_care' || service === 'boracare') return true;
  const text = cleanText([row.label, row.name, row.displayName, row.detail, row.summary].filter(Boolean).join(' '))
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  // Mirror isBoraCareOneTimeItem in estimate-public.js: a row is Bora-Care if it
  // reads "bora care" OR mentions "borate", so borate-labeled rows are recognized.
  return /bora\s*care/.test(text) || text.includes('borate');
}

// True when the estimate itself is a German Roach Cleanout (canonical service
// key or a cleanout-specific label). The question text alone can't distinguish
// German Roach Cleanout from a native/palmetto cockroach or a recurring pest
// plan with an Initial German Roach Knockdown add-on, so German-roach cleanout
// copy must be gated on this exact service context.
function estimateMentionsGermanRoach(context = {}) {
  const rows = [
    ...(Array.isArray(context.services) ? context.services : []),
    ...(Array.isArray(context.oneTime?.items) ? context.oneTime.items : []),
  ];
  return rows.some(isGermanRoachCleanoutContextRow);
}

function treatmentApproachForQuestion(question = '', context = {}) {
  const q = cleanText(question).toLowerCase();
  if (/\b(roach|roaches|cockroach|cockroaches)\b/.test(q)) {
    if (estimateMentionsGermanRoach(context)) {
      return 'For German roaches, the cleanout runs as a multi-visit program — each visit targets the live population and the next generation to break the breeding cycle, with prep guidance so the treatment holds. The number of visits is shown on this estimate.';
    }
    return 'For cockroaches, treatment targets harborage areas, entry points, and food and moisture sources, with follow-up based on the activity found at your property.';
  }
  // Whole-word only: `ants\b` alone would match the suffix of "plants", and
  // watering questions ("can I water my plants after treatment?") route
  // through here via the safety branch.
  if (/\bants?\b/.test(q)) {
    return 'For ants, the goal is to reduce exterior entry pressure, treat trails and nesting zones when found, and support interior activity when it is included or needed.';
  }
  if (/\bbed\s*bug|bedbug\b/.test(q)) {
    return 'For bed bugs, the approach depends on inspection findings and can combine targeted crack-and-crevice treatment, growth-regulator strategy, and follow-up guidance.';
  }
  // Family-level copy must scope the way the label facts below it do:
  // serviceFamiliesFromText strips recipient wording, so "is the mosquito
  // spray safe for the lawn?" reads mosquito — a raw-text regex would see
  // "lawn" first and open with lawn copy above mosquito label facts. Raw
  // text still decides when no single family survives (untargeted or
  // coordinated questions keep their previous behavior).
  const families = serviceFamiliesFromText(q);
  const family = families.length === 1 ? families[0] : null;
  if (family === 'lawn_care' || (!family && /\blawn|turf|grass|weed|fungus|fertil|chinch\b/.test(q))) {
    return 'For lawns, Waves starts from turf condition, weed pressure, fungus pressure, irrigation clues, and seasonal Southwest Florida restrictions before selecting the treatment.';
  }
  if (family === 'mosquito' || (!family && /\bmosquito|mosquitoes\b/.test(q))) {
    return 'For mosquitoes, the focus is shaded resting zones, breeding-pressure checks, and timing around weather so the barrier treatment has the best chance to hold.';
  }
  if (family === 'termite_bait' || (!family && /\btermite|termites\b/.test(q))) {
    return 'For termites, the treatment method depends on whether the estimate is for monitoring, bait, soil treatment, or a construction-stage treatment.';
  }
  return 'The technician selects the treatment method from the service type, inspection findings, label directions, and conditions at your property that day.';
}

function findService(context = {}, pattern) {
  // Search both the recurring service list and one-time items. In recurring
  // mode context.services holds only the recurring rows, so a separately-billed
  // one-time line (e.g. a German Roach Cleanout alongside a lawn plan) would be
  // missed and the fallback would wrongly say "I do not see pest control".
  const rows = [
    ...(Array.isArray(context.services) ? context.services : []),
    ...(Array.isArray(context.oneTime?.items) ? context.oneTime.items : []),
  ];
  return rows.find((row) => pattern.test(`${row.label || ''} ${row.detail || ''} ${row.summary || ''}`));
}

function listFirstVisitFees(context = {}) {
  const fees = Array.isArray(context.firstVisitFees)
    ? context.firstVisitFees
    : (context.setupFee ? [context.setupFee] : []);
  return fees
    .filter((fee) => Number.isFinite(Number(fee.amount)) && Number(fee.amount) > 0)
    .map((fee) => {
      const label = cleanText(fee.label || 'First-visit fee');
      const waiver = fee.waivedWithPrepay
        ? ' and is waived when the 12-month plan is paid in full'
        : '';
      return `The ${label} is ${fmtMoney(fee.amount)}${waiver}.`;
    })
    .join(' ');
}

// True when the estimate itself includes Bora-Care (recurring service row or
// one-time item). The deterministic Bora-Care answer is gated on this so a
// wood/beetle/borate question on a non-Bora estimate never implies the quote
// includes borate wood treatment.
function estimateContextHasBoraCare(context = {}) {
  const rows = [
    ...(Array.isArray(context.services) ? context.services : []),
    ...(Array.isArray(context.oneTime?.items) ? context.oneTime.items : []),
  ];
  return rows.some(isBoraCareContextRow);
}

// True when the estimate itself is the mosquito misting SYSTEM (lead-only,
// quote-on-request — mosquito_misting_system) via the shared predicate on
// either row's catalog key or label/name, mirroring estimateContextHasBoraCare.
function mistingContextRows(context = {}) {
  return [
    ...(Array.isArray(context.services) ? context.services : []),
    ...(Array.isArray(context.oneTime?.items) ? context.oneTime.items : []),
    ...(Array.isArray(context.quoteOnlyItems) ? context.quoteOnlyItems : []),
    // Retained recurring rows too: in one_time mode the builder moves the
    // plan's recurring services here, and a mixed estimate must not read as
    // misting-only.
    ...(Array.isArray(context.recurringServices) ? context.recurringServices : []),
  ];
}

function estimateContextHasMistingSystem(context = {}) {
  const rows = mistingContextRows(context);
  return rows.some((row) => isMistingSystemService({ serviceKey: row?.service || row?.key, name: row?.label || row?.name }));
}

// A mixed estimate (misting + another service) only routes a question to the
// misting fallback when the question is about the misting system; questions
// about the other service keep their own branches.
function estimateContextIsMistingOnly(context = {}) {
  const rows = mistingContextRows(context);
  return rows.length > 0 && rows.every((row) => isMistingSystemService({ serviceKey: row?.service || row?.key, name: row?.label || row?.name }));
}

function isMistingSystemQuestion(q = '') {
  // Bare "mist"/"misting" is barrier wording ("21-day misting") and does not count.
  return isMistingSystemService({ text: q }) || /\b(misters?|nozzles?|design\s*visit|reservoir)\b/i.test(q);
}

// Misting-system copy, sourced from wiki/protocols/mosquito-misting-systems.md
// (the tech protocol — the source of truth for every fact below).
//
// Deliberately ONE fixed answer, not a keyword intent router. Seven Codex
// rounds on #4779 kept finding natural-language collisions in regex routing
// ("how much wind", "cycle schedule", "tech inspect after a hurricane",
// "will it come on if it rains", "service appointment"...). A misrouted
// answer here is worse than a complete one, so every misting question gets
// the same short answer covering the design visit, placement and re-entry,
// weather and storm pauses, maintenance, label precautions, exposure, and the
// no-disease-prevention line. It never states a price and never offers online
// booking (the system is design-visit-first, not self-bookable —
// wiki/services/service-dispatch-rules.md).
function mistingSystemFallbackAnswer(_question, phone) {
  return [
    `Misting systems are designed and priced at a free on-site design visit — there is no published price and it is not booked online; the Waves team will call to schedule it (or call or text ${phone}).`,
    'Once installed, nozzles sit under 10 ft, aimed away from pools, ponds, dining areas, and air intakes, and cycles run at dawn and dusk; stay out of the misted area until the mist has settled and treated surfaces are dry, as the product label directs, and your technician will confirm re-entry timing.',
    'Cycles should be paused for rain, fog, wind over 10 mph, or temperatures below 50°F — by an optional weather sensor where one is installed, otherwise from the app — and before a named storm we pause systems, then inspect them before resuming.',
    'The service plan covers monthly checks and refills plus quarterly nozzle cleaning and a filter change; only Waves-licensed techs refill the solution.',
    '"Botanical" products can still be toxic to bees or fish, so the specific product label decides; if you suspect any exposure, pause the system and call the office right away.',
    'The system reduces adult mosquitoes in the treated zone; it does not prevent disease.',
  ].join(' ');
}

// A question is a Bora-Care intent only when it names Bora-Care/borate, or pairs
// "wood" with a treatment/pest term. Bare "beetle"/"fungi" do NOT qualify, so on a
// mixed estimate a lawn-fungus or shrub-beetle question still reaches the relevant
// service branch instead of the wood-treatment answer.
function isBoraCareIntent(question = '') {
  const text = String(question).toLowerCase();
  // Accept "bora care", "bora-care", "boracare", and "borate" (mirrors the row
  // classifier); "wood" still needs a treatment/pest term to qualify.
  return /bora[\s-]?care/.test(text)
    || text.includes('borate')
    || (/\bwood/.test(text) && /(treat|destroy|beetle|fungi|boring|decay)/.test(text));
}

// A satisfaction clause written in a row's own detail ("Satisfaction
// guaranteed for the initial treatment only."), never a negated one. On a
// no-guarantee estimate rowWithSummary has already removed these clauses.
function writtenSatisfactionClause(detail) {
  return cleanText(detail).split(/(?<=[.!?;])\s+/)
    .find((part) => /\bsatisfaction guaranteed\b/i.test(part)
      && !/\b(?:no|not|never|without|excluded|isn't|is not|doesn't|does not)\b/i.test(part)) || null;
}

// The per-service terms list for an estimate without estimate-wide terms
// (AGENTS.md estimate truth scope, owner 2026-09-26/27). The assistant never
// guesses from the wording of a question which service is meant; every
// guarantee question gets this one list. A termite row states its purchased
// terms (a selected bond, a purchased trenching warranty), a pre-slab job its
// warranty option, or else "No guarantee.". Any other row states the
// satisfaction clause written in its own detail, which rowWithSummary has
// already removed on an estimate with termite work, as the page does. The
// model context and the fallback answer read this one list.
function serviceTermsFromRows(rowGroups = [], oneTimeRows = [], { ownTerms = () => [] } = {}) {
  const oneTimeIdentities = new Set(oneTimeRows.map(trenchingServiceIdentity));
  const seen = new Set();
  // The same job is projected into several groups (services, recurring,
  // one-time rows), so a repeated projection collapses across groups. Two
  // identical current jobs inside one group (two $900 trenching jobs that
  // both purchased the warranty) are distinct jobs: each occurrence keeps its
  // place, so the positional naming below lists both (Codex #4982).
  const groups = rowGroups.every(Array.isArray) ? rowGroups : [rowGroups];
  const entries = groups.flatMap((group) => {
    const occurrences = new Map();
    return group.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      // Engine frequency inclusions can carry a bare service-key placeholder
      // for a separately priced add-on. It is not a distinct job.
      const unpricedPlaceholder = !row.oneTime && !oneTimeRows.includes(row)
        && oneTimeIdentities.has(trenchingServiceIdentity(row))
        && cleanText(row.label).toLowerCase() === cleanText(row.service).toLowerCase()
        && !row.purchasedTerms?.length
        && ![row.amount, row.monthly, row.perApplication].some(Number.isFinite);
      if (unpricedPlaceholder) return [];
      const lanes = rowGuaranteeLanes(row);
      const purchased = Array.isArray(row.purchasedTerms) ? row.purchasedTerms : [];
      let terms;
      if (lanes.some((lane) => TERMITE_LANES.has(lane))) {
        // A bond is itself the purchase: a bond row with no purchase says nothing.
        // Neither does an unpriced row labeled with its bare service key (the
        // engine's inclusion placeholder for a separately priced add-on).
        const bareKeyPlaceholder = cleanText(row.label).toLowerCase() === cleanText(row.service).toLowerCase()
          && ![row.amount, row.monthly, row.perApplication].some((value) => Number.isFinite(value) && value > 0);
        if (!purchased.length && (bareKeyPlaceholder || cleanText(row.service).toLowerCase().startsWith('termite_bond'))) {
          return [];
        }
        const warranty = Array.isArray(row.warrantyTerms) ? row.warrantyTerms : [];
        terms = purchased.length ? purchased : (warranty.length ? warranty : ['No guarantee.']);
      } else {
        const clause = writtenSatisfactionClause(row.detail);
        terms = [...purchased, ...ownTerms(row), ...(clause ? [`The written detail says “${clause}”`] : [])];
        if (!terms.length) return [];
      }
      const amount = Number(row.amount);
      const entry = {
        service: cleanText(row.label) || 'Service',
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        terms,
      };
      const key = [row.service, entry.service, entry.amount, ...terms].map(cleanText).join('|').toLowerCase();
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      if (seen.has(`${key}#${occurrence}`)) return [];
      seen.add(`${key}#${occurrence}`);
      return [entry];
    });
  });
  // Same-label jobs are named by price, and by position when the price repeats.
  return entries.map((entry) => {
    const sameLabel = entries.filter((other) => other.service === entry.service);
    if (sameLabel.length === 1 || entry.amount === null) return { service: entry.service, terms: entry.terms };
    const samePrice = sameLabel.filter((other) => other.amount === entry.amount);
    const name = samePrice.length === 1
      ? `${entry.service} at ${fmtMoney(entry.amount)}`
      : `${entry.service} job ${samePrice.indexOf(entry) + 1} of ${samePrice.length} at ${fmtMoney(entry.amount)}`;
    return { service: name, terms: entry.terms };
  });
}

// An estimate without estimate-wide terms: termite or unclassifiable work
// (noGuaranteeClaims), a recurring plan whose services don't share one
// recurring-terms lane, or a one-time job with no one-time terms of its own
// (only one-time pest carries the callback period).
function withoutEstimateWideTerms(context = {}) {
  const guarantees = context.guarantees || {};
  if (guarantees.noGuaranteeClaims === true) return true;
  return context.serviceMode === 'one_time'
    ? !guarantees.oneTime
    : guarantees.recurringTermsEligible !== true;
}

// A guarantee question on such an estimate, including recurrence wording
// ("What if the termites come back?"). Only the deterministic per-service
// answer takes it: the fallback answers it first, and answerEstimateQuestion
// routes it there before the live models, so no model picks which service a
// question means. servedModelAnswer covers any other wording.
// Recurrence wording counts only with a pest as its subject: "When will you
// return for the next treatment?" is a scheduling question.
const RECURRING_PEST = '(?:termites|pests|bugs|(?:cock)?roach(?:es)?|ants|spiders|rodents|rats|mice|mosquito(?:e)?s|fleas|ticks|wasps|bees|beetles)';
// Two tiers of guarantee wording. A question that NAMES a guarantee term
// (any inflection: "Is this guaranteed?", "Am I covered?", "Is it
// warrantied?") asks about terms whatever else it mentions, so only a
// genuine price question leaves the deterministic answer; scheduling wording
// does not ("Is my next visit covered by the warranty?"). Re-treatment and
// recurrence wording can also be scheduling ("How often do you retreat the
// lawn?"), so scheduling wording leaves it. "bond" stays exact: "licensed
// and bonded" asks about the company, not a termite bond (Codex #4982).
const EXPLICIT_GUARANTEE_PATTERN = /\b(?:guarant\w*|warrant\w*|call[- ]?backs?|money[- ]?back|satisf\w*|risk[- ]?free|bonds?|annual inspection|cover(?:age|ed))\b/i;
const RECURRENCE_SUBJECT = `(?:${RECURRING_PEST}|they|it)`;
const RECURRENCE_QUESTION_PATTERN = new RegExp(
  '\\b(?:re-?treat\\w*|re-?service\\w*'
  + `|${RECURRENCE_SUBJECT}(?:\\s+(?:ever|still|just|then))?\\s+(?:come|comes|coming|came)\\s+back`
  + `|${RECURRENCE_SUBJECT}(?:\\s+(?:ever|still|just|then))?\\s+return(?:s|ed|ing)?`
  + `|treat(?:ed|ing)?\\s+(?:them|it|the\\s+${RECURRING_PEST})\\s+again)\\b`,
  'i',
);
// A price question asks for an amount of money: "How much does the 5-year
// bond cost?", "What's the price of the warranty?", "How much is the bond?",
// "How much for the 5-year bond?" (Codex #4982). "How much" alone is not one
// ("How much warranty coverage do I get?", "How much is covered?", "How much
// for coverage?"), and a dollar figure or cost that names a job ("Does the
// cost of trenching include a warranty?") is still a guarantee question.
const PRICE_QUESTION_PATTERN = new RegExp([
  '\\bhow much\\b[^?.!]*\\b(?:costs?|prices?|charges?|fees?|run)\\b',
  "\\bwhat(?:\\s+(?:does|do|is|would|will)|['’]s)\\b[^?.!]*\\b(?:costs?|prices?)\\b",
  '\\bhow much (?:is|are|would|will|for)\\b(?![^?.!]*\\b(?:cover\\w*|guarant\\w*|warrant\\w*)\\b)',
].join('|'), 'i');
// Scheduling wording is a scheduling question: "How often do you retreat the
// lawn?", "When will you treat the yard again?".
const SCHEDULING_QUESTION_PATTERN = /\bhow often\b|\bwhat (?:day|time)\b|\bschedul\w*|\bappointment\b|\bnext (?:visit|treatment|service|application)\b|\bwhen (?:will|do|can|should|is|are) (?:you|the tech|your tech|someone|a tech)\b/i;
function answersWithServiceTerms(question, context = {}) {
  const q = cleanText(question);
  if (!withoutEstimateWideTerms(context) || PRICE_QUESTION_PATTERN.test(q)) return false;
  return EXPLICIT_GUARANTEE_PATTERN.test(q)
    || (RECURRENCE_QUESTION_PATTERN.test(q) && !SCHEDULING_QUESTION_PATTERN.test(q));
}

// On an estimate without estimate-wide terms, a model answer that makes a
// plan-terms claim (callbacks, money-back, satisfaction, no-contract, free
// re-service) is never served: the deterministic answer for the same question
// is. Setup and prepay refund wording is not a plan-terms claim.
function servedModelAnswer(answer, source, question, context) {
  if (withoutEstimateWideTerms(context) && PLAN_TERMS_COPY.test(answer)) {
    return { answer: answerEstimateQuestionFallback(question, context), source: 'fallback' };
  }
  return { answer, source };
}

// The guarantee answer for an estimate without estimate-wide terms: the same
// answer whatever the question's wording, listing each service's own terms.
function serviceTermsAnswer(context = {}, phone, noGuaranteeAnswer) {
  const oneTimeRows = Array.isArray(context.oneTime?.items) ? context.oneTime.items : [];
  const entries = Array.isArray(context.guarantees?.serviceTerms)
    ? context.guarantees.serviceTerms
    : serviceTermsFromRows([context.services, context.recurringServices, oneTimeRows].filter(Array.isArray), oneTimeRows);
  if (!entries.length) return noGuaranteeAnswer;
  const lines = entries.map((entry) => `${entry.service}: ${entry.terms.join(' ').replace(/([^.!?”])$/, '$1.')}`);
  return `This estimate’s written service scope and terms are what apply. ${lines.join(' ')} Each of those terms applies to that service only. I do not see an estimate-wide callback or money-back guarantee listed; call or text Waves at ${phone} if you want the team to confirm coverage for a specific service.`;
}

function answerEstimateQuestionFallback(question, context = {}) {
  const q = cleanText(question).toLowerCase();
  const phone = context.company?.phone || COMPANY.phone;
  const tier = context.waveGuardTier || 'WaveGuard';
  const billingText = context.billing?.amountText;
  const services = listServices(context);
  const oneTimeText = context.oneTime?.amountText;
  const noGuaranteeAnswer = `This estimate’s written service scope and terms are what apply. I do not see an estimate-wide callback or money-back guarantee listed; call or text Waves at ${phone} if you want the team to confirm coverage for a specific service.`;

  // Runs first, ahead of the service-specific shortcuts (Bora-Care, the
  // misting system) and the generic "included/coverage" branch. On an estimate
  // without estimate-wide terms every guarantee question, "Does Bora-Care
  // include a warranty?" too, gets each service's own terms (AGENTS.md, owner
  // 2026-09-27). This answer states no price and offers no booking, so the
  // shortcuts' own guards still hold.
  const neutralRecurringTerms = context.serviceMode !== 'one_time' && context.guarantees?.recurringTermsEligible !== true;
  if (answersWithServiceTerms(q, context)) {
    return serviceTermsAnswer(context, phone, noGuaranteeAnswer);
  }

  // Bora-Care questions are answered first — above the include/coverage, safety,
  // and product branches — so phrasings like "does Bora-Care cover beetles?" or
  // "is Bora-Care safe?" reach the borate-specific answer instead of the generic
  // service list or label-direction copy. Gated on the estimate actually including
  // Bora-Care AND a qualified Bora-Care intent so a lawn-fungus / shrub-beetle
  // question on a mixed estimate still reaches the relevant service branch.
  if (estimateContextHasBoraCare(context) && isBoraCareIntent(q)) {
    return `Bora-Care is a borate treatment applied to bare wood — attic framing and surface areas like the foundation and block. It treats the wood for termites, wood-boring beetles, and wood-decay fungi. Your technician follows the product label directions; for specifics on your home, call or text Waves at ${phone}.`;
  }

  // The mosquito misting SYSTEM (mosquito_misting_system) is lead-only and
  // quote-required by design — no engine pricer exists yet, so every branch
  // below that answers a normal quote-required estimate is wrong for it: the
  // scheduling branch offers "pick a time to book online" and the system is
  // NOT self-bookable (wiki/services/service-dispatch-rules.md), and no
  // branch may ever state a price for it (pricing is owner-pending).
  // Answered here, ahead of every other branch, so no phrasing of the
  // question can reach the wrong copy — but intent-routed within itself
  // (mistingSystemFallbackAnswer) so a weather, safety, or maintenance
  // question gets its own protocol-sourced answer instead of design-visit/
  // pricing copy on every question.
  if (context.billing?.quoteRequired && estimateContextHasMistingSystem(context)
    && (estimateContextIsMistingOnly(context) || isMistingSystemQuestion(q))) {
    return mistingSystemFallbackAnswer(question, phone);
  }

  if (/\b(include|included|cover|coverage|what.*get|plan)\b/.test(q)) {
    return [
      `This ${tier} estimate includes:`,
      services,
      billingText ? (context.serviceMode === 'one_time'
        ? `The one-time estimate is ${billingText}.`
        : `The recurring estimate is shown as ${billingText}.`) : '',
      context.billing?.quoteRequired ? 'This estimate needs an inspection before final pricing can be completed online.' : '',
    ].filter(Boolean).join('\n');
  }

  if (/\b(price|cost|billing|bill|pay|payment|charge|quarter|month|annual|year|setup|fee|discount)\b/.test(q)) {
    if (context.billing?.quoteRequired) {
      return `This estimate needs an inspection before final pricing or online acceptance. Call or text Waves at ${phone} and the team can finish the quote.`;
    }
    if (context.serviceMode === 'one_time' && oneTimeText) {
      return [
        `The one-time estimate is ${oneTimeText}.`,
        'This is a single visit, not a recurring WaveGuard plan.',
        listFirstVisitFees(context),
      ].filter(Boolean).join(' ');
    }
    if (context.billing?.invoiceMode) {
      return [
        billingText ? `Your ${tier} estimate is shown as ${billingText}.` : `This estimate uses ${tier} pricing.`,
        context.billing?.invoiceDueText ? `If approved, Waves creates an invoice due immediately for ${context.billing.invoiceDueText} and sends the payment link.` : 'If approved, Waves creates an invoice due immediately and sends the payment link.',
        'No card is collected on this page.',
      ].filter(Boolean).join(' ');
    }
    const firstVisitFees = listFirstVisitFees(context);
    return [
      billingText ? `Your ${tier} estimate is ${billingText}.` : `This estimate uses ${tier} pricing.`,
      context.billing?.serviceCadence ? `Service visits are ${context.billing.serviceCadence}.` : '',
      context.billing?.billedAfterVisit ? 'You are billed after completed service visits unless you choose the 12-month pay-in-full option.' : '',
      context.billing?.annualText ? `The 12-month plan total shown is ${context.billing.annualText}.` : '',
      firstVisitFees,
    ].filter(Boolean).join(' ');
  }

  // water/irrigat/sprinkl + rainfast/rain-after phrasings: watering and
  // rainfast questions are force-routed to this fallback, and the label
  // watering guidance + rainfast window live in labelSafetyFacts — so they
  // must land in this branch. Bare "rain"/"treatment" deliberately do NOT
  // match: "will you still come if it rains?" (scheduling) and "how long
  // does the treatment last?" (duration) belong to the branches below.
  // Same intent anchoring as the force gate: irrigation-context "water",
  // people/pet "keep off", treatment-anchored rain-after in BOTH word
  // orders ("rains after my service" / "after my service can it rain"),
  // re-entry/dry wording. "water bugs"/"standing water"/"keep mosquitoes
  // off" are service questions and belong to the branches below.
  if (/\b(safe|pets?|dogs?|cats?|kids?|child|children|precautions?|chemical|product|products|spray|label|applied|application|irrigat\w*|sprinkl\w*|rain[-\s]?fast|rain[-\s]?proof|re-?ent(?:er|ry|ering)\w*|dry|dries|dried|drying)\b|\bkeep\s+(?:people|pets?|kids?|children|dogs?|cats?|everyone|family)\s+off\b|\bkeep\s+off\b|\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)(?=[^.?!]{0,40}\b(?:after|before|until|lawn|turf|grass|yard|plants?|treat\w*|appl\w*|spray\w*|dry|dries|dried)\b)|\b(?:after|before|until|once|when|how\s+soon|how\s+long)\b[^.?!]{0,40}\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)|\brains?\s+(?:right\s+)?after\s+(?:(?:the|my|a|an|our|your|you|we)\s+)?(?:(?:lawn|turf|grass|yard|pest|bug|mosquito|termite|rodent|flea|tick|tree|shrub|weed|fungus|perimeter|barrier|care|control|quarterly|monthly|first|next|initial)\s+){0,3}(?:treat\w*|appl\w*|spray\w*|services?|visits?)\b|\bafter\s+(?:(?:the|my|a|an|our|your|you|we)\s+)?(?:(?:lawn|turf|grass|yard|pest|bug|mosquito|termite|rodent|flea|tick|tree|shrub|weed|fungus|perimeter|barrier|care|control|quarterly|monthly|first|next|initial)\s+){0,3}(?:treat\w*|appl\w*|spray\w*|services?|visits?)\b[^.?!]{0,40}\brains?\b|\b(?:treat|appl|spray)\w*\b[^.?!]{0,40}\bafter\s+(?:it\s+|the\s+)?rains?\b|\brain\s+wash\w*\b/.test(q)) {
    const activeIngredients = activeIngredientsFromSupport(context, question);
    const labelSafetyFacts = labelSafetyFactsFromSupport(context, question);
    const labelCopy = 'Your technician will follow the product label directions for every application.';
    if (activeIngredients.length) {
      return [
        `${treatmentApproachForQuestion(question, context)} Active ingredients/classes in the admin catalog for this service type include ${activeIngredients.join(', ')}.`,
        labelSafetyFacts,
        `${labelCopy} If you have pets, kids, sensitivities, or want the exact product for your home that day, call or text Waves at ${phone}.`,
      ].filter(Boolean).join(' ');
    }
    return [
      `${treatmentApproachForQuestion(question, context)}`,
      labelSafetyFacts,
      `${labelCopy} If you have pets, kids, sensitivities, or a specific product question, call or text Waves at ${phone} so the team can give instructions for your home.`,
    ].filter(Boolean).join(' ');
  }

  if (/\b(lawn|turf|weed|fungus|grass|fertil)\b/.test(q)) {
    const lawn = findService(context, /lawn|turf|weed|fungus|grass|fertil/i);
    const activeIngredients = activeIngredientsFromSupport(context, question);
    return lawn
      ? [
          `For lawn care, this estimate shows ${lawn.summary}.`,
          treatmentApproachForQuestion(question, context),
          activeIngredients.length ? `Relevant active ingredients/classes in the admin catalog include ${activeIngredients.join(', ')}.` : '',
        ].filter(Boolean).join(' ')
      : `I do not see lawn care on this estimate. Call or text Waves at ${phone} if you want it added.`;
  }

  if (/\b(pest|bugs?|roach(?:es)?|cockroach(?:es)?|ants?|spider|inside|interior|outside|exterior)\b/.test(q)) {
    const pest = findService(context, /pest|roach|ant|spider|perimeter/i);
    const activeIngredients = activeIngredientsFromSupport(context, question);
    return pest
      ? [
          `For pest control, this estimate shows ${pest.summary}.`,
          treatmentApproachForQuestion(question, context),
          activeIngredients.length ? `Relevant active ingredients/classes in the admin catalog include ${activeIngredients.join(', ')}.` : '',
        ].filter(Boolean).join(' ')
      : `I do not see pest control on this estimate. Call or text Waves at ${phone} if you want it added.`;
  }

  if (/\b(schedule|appointment|book|time|when|date|visit|tech|technician)\b/.test(q)) {
    return `Pick one of the available times on this estimate to book online. If none of the listed windows work, call or text Waves at ${phone} and the team can help with scheduling.`;
  }

  if (/\b(waveguard|silver|bronze|gold|platinum|member|membership|guarantee|callback|risk)\b/.test(q)) {
    if (context.guarantees?.noGuaranteeClaims === true) {
      return noGuaranteeAnswer;
    }
    if (context.serviceMode === 'one_time') {
      return context.guarantees?.oneTime
        ? `This is a one-time service, not a recurring WaveGuard membership. ${context.guarantees.oneTime}`
        : noGuaranteeAnswer;
    }
    if (neutralRecurringTerms) return noGuaranteeAnswer;
    return `${tier} is the WaveGuard membership level shown on this estimate. Recurring WaveGuard service includes the money-back guarantee shown here, member pricing, and ongoing service support from Waves.`;
  }

  if (/\b(who|waves|company|local|license|insured|contact|phone|text|email)\b/.test(q)) {
    return `Waves Pest Control is a local ${COMPANY.serviceArea} pest control and lawn care company. You can call or text ${phone}, or email ${COMPANY.email}.`;
  }

  return `I can answer questions about this estimate, pricing, included services, billing, scheduling, or Waves. For anything not shown here, call or text Waves at ${phone}.`;
}

function extractAnthropicText(response = {}) {
  return (Array.isArray(response.content) ? response.content : [])
    .filter((part) => part.type === 'text')
    .map((part) => cleanAssistantAnswer(part.text))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildAssistantUserContent(question, context) {
  return `Customer question:\n${question}\n\nEstimate context JSON:\n${JSON.stringify(context, null, 2)}`;
}

// Live model — GPT-5.5 (ROUTES.estimateAssistant). Prose answer (jsonMode:false);
// on any miss returns null so answerEstimateQuestion falls back to Claude.
async function answerWithOpenAI(question, context) {
  const r = await dispatch(MODELS.ROUTES.estimateAssistant, {
    laneId: 'estimate_assistant',
    system: SYSTEM_PROMPT,
    text: buildAssistantUserContent(question, context),
    jsonMode: false,
    maxTokens: 420,
  });
  if (!r.ok || !r.text) return null;
  const answer = cleanAssistantAnswer(r.text);
  if (!answer) rejectCall(r, 'invalid_output');
  return answer || null;
}

async function answerWithAnthropic(question, context) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await ledgerCall('anthropic', process.env.ESTIMATE_ASSISTANT_MODEL || MODELS.WORKHORSE, () => client.messages.create({
    model: process.env.ESTIMATE_ASSISTANT_MODEL || MODELS.WORKHORSE,
    max_tokens: 420,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildAssistantUserContent(question, context),
    }],
  }), { laneId: 'estimate_assistant' });
  // Same rule as the OpenAI leg: text the sanitizer strips to nothing is an
  // unusable answer (the caller serves the template), so fail the row.
  const answer = extractAnthropicText(response);
  if (!answer) ledgerCallRejected(response, 'invalid_output');
  return answer;
}

async function answerEstimateQuestion({
  question,
  estimate,
  estData,
  pricingBundle,
  selectedFrequency,
  serviceMode,
  noGuaranteeClaims = false,
  noEstimateWideGuarantee = false,
  commercialScope = false,
  database = db,
} = {}) {
  const cleanQuestion = cleanText(question);
  const context = buildEstimateAssistantContext({
    estimate,
    estData,
    pricingBundle,
    selectedFrequency,
    serviceMode,
    noGuaranteeClaims,
    noEstimateWideGuarantee,
    commercialScope,
  });
  try {
    context.supportContext = await loadEstimateAiSupportContext({
      db: database,
      question: cleanQuestion,
      context,
    });
  } catch (err) {
    logger.warn(`[estimate-assistant] support context skipped: ${err.message}`);
  }

  if (context.billing?.quoteRequired) {
    return {
      answer: answerEstimateQuestionFallback(cleanQuestion, context),
      source: 'fallback',
    };
  }

  // Guarantee questions on an estimate without estimate-wide terms get the
  // deterministic per-service answer, never a model's reading of which
  // service the question means (owner ruling 2026-09-27).
  if (answersWithServiceTerms(cleanQuestion, context)) {
    return {
      answer: answerEstimateQuestionFallback(cleanQuestion, context),
      source: 'fallback',
    };
  }

  // Bora-Care intents are answered deterministically (controlled borate copy), so
  // route them to the fallback before the live models. The new Bora-Care chip and
  // coverage phrasings don't match the generic force-fallback gate below, so they
  // would otherwise reach the LLM and bypass the guaranteed borate answer.
  if (estimateContextHasBoraCare(context) && isBoraCareIntent(cleanQuestion)) {
    return {
      answer: answerEstimateQuestionFallback(cleanQuestion, context),
      source: 'fallback',
    };
  }

  // AW-04: before the public estimate context was restricted to customer-safe
  // sources, the WaveGuard repo file matched the mandatory 'WaveGuard' search
  // term on every request, so supportRows(context) was never empty and this
  // route was effectively unconditional. Removing the internal repo sources
  // must not move pesticide/product/safety questions onto the live model when
  // the remaining support lookups return nothing (e.g. a DB outage), so the
  // route stays unconditional — the same behavior as before, stated directly.
  if (FORCE_FALLBACK_QUESTION_PATTERN.test(cleanQuestion)) {
    return {
      answer: answerEstimateQuestionFallback(cleanQuestion, context),
      source: 'fallback',
    };
  }

  // Live model — GPT-5.5. On any miss, fall back to Claude (WORKHORSE), then the
  // deterministic template — the customer always gets an answer.
  try {
    const openAiAnswer = await answerWithOpenAI(cleanQuestion, context);
    if (openAiAnswer) return servedModelAnswer(openAiAnswer, 'openai', cleanQuestion, context);
  } catch (err) {
    logger.warn(`[estimate-assistant] OpenAI answer failed: ${err.message}`);
  }

  try {
    const aiAnswer = await answerWithAnthropic(cleanQuestion, context);
    if (aiAnswer) return servedModelAnswer(aiAnswer, 'anthropic', cleanQuestion, context);
  } catch (err) {
    logger.warn(`[estimate-assistant] AI answer failed: ${err.message}`);
  }

  return {
    answer: answerEstimateQuestionFallback(cleanQuestion, context),
    source: 'fallback',
  };
}

module.exports = {
  answerEstimateQuestion,
  answerEstimateQuestionFallback,
  buildEstimateAssistantContext,
  cleanAssistantAnswer,
  selectPricingFrequency,
  FORCE_FALLBACK_QUESTION_PATTERN,
};
