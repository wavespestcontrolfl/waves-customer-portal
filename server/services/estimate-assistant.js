const logger = require('./logger');
const MODELS = require('../config/models');
const db = require('../models/db');
const { WAVEGUARD } = require('./pricing-engine/constants');
const { loadEstimateAiSupportContext, serviceKeysFromContext, serviceFamiliesFromText } = require('./estimate-ai-context');
const { dispatch } = require('./llm/call');

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

function serviceRowsFromEstimateData(estData = {}) {
  const result = estData.result || estData.engineResult || estData || {};
  const recurring = result.recurring || estData.recurring || {};
  const services = Array.isArray(recurring.services) ? recurring.services : [];
  return services.map((service) => ({
    service: cleanText(service.service || service.key) || null,
    label: normalizeServiceName(service.displayName || service.label || service.name || service.service),
    cadence: cleanText(service.frequencyLabel || service.cadence || service.frequency),
    detail: cleanText(service.detail || service.description),
    monthly: Number(service.mo ?? service.monthly ?? service.monthlyTotal),
    visitsPerYear: Number(service.visitsPerYear ?? service.visits ?? service.apps),
    perApplication: Number(service.perTreatment ?? service.perApp ?? service.perVisit),
  }));
}

function waveGuardDiscountForTier(value) {
  const key = cleanText(value)
    .toLowerCase()
    .replace(/^waveguard\s+/, '');
  return WAVEGUARD.tiers[key]?.discount || 0;
}

function waveGuardDiscountAppliesToService(service = {}) {
  const key = cleanText(service.service || service.key).toLowerCase();
  if (key === 'palm_injection' || key === 'rodent_bait' || service.waveGuardDiscountEligible === false) return false;
  if (key && WAVEGUARD.qualifyingServices.includes(key)) return true;
  const rawLabel = cleanText(service.label || service.name || service.service).toLowerCase();
  if ((/\bpalms?\b|\bpalm injection\b/.test(rawLabel)) || (rawLabel.includes('rodent') && rawLabel.includes('bait'))) return false;
  const label = normalizeServiceName(service.label || service.name || service.service);
  return ['Pest Control', 'Lawn Care', 'Mosquito Control', 'Termite Service', 'Tree & Shrub Service'].includes(label);
}

function serviceRowsFromPricing(pricingBundle = {}, selectedFrequency = null) {
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
    const label = normalizeServiceName(service.label || service.service || service.key);
    const current = byLabel.get(label) || { label };
    byLabel.set(label, {
      ...current,
      service: current.service || cleanText(service.service || service.key) || null,
      label,
      cadence: current.cadence || serviceCadence,
      detail: current.detail || cleanText(service.detail),
    });
  });

  perTreatments.forEach((service) => {
    const label = normalizeServiceName(service.label || service.service);
    const current = byLabel.get(label) || { label };
    const rawPerTreatment = Number(service.perTreatment);
    const rowMultiplier = waveGuardDiscountAppliesToService(service)
      ? (shouldApplyTierDiscount ? (1 - waveGuardDiscount) : 1) * discountableAdjustment
      : 1;
    const perApplication = Number.isFinite(rawPerTreatment) && rawPerTreatment > 0
      ? Math.round(rawPerTreatment * rowMultiplier * 100) / 100
      : null;
    byLabel.set(label, {
      ...current,
      service: current.service || cleanText(service.service || service.key) || null,
      perApplication,
      visitsPerYear: Number(service.visitsPerYear),
    });
  });

  return [...byLabel.values()];
}

function mergeServiceRows(primaryRows = [], fallbackRows = [], options = {}) {
  const byLabel = new Map();
  const allowFallbackOnly = options.allowFallbackOnly !== false;
  const primaryLabels = new Set(primaryRows.map((row) => (
    row.oneTime
      ? (cleanText(row.label) || 'One-time service')
      : normalizeServiceName(row.label)
  )));
  [...fallbackRows, ...primaryRows].forEach((row) => {
    const label = row.oneTime
      ? (cleanText(row.label) || 'One-time service')
      : normalizeServiceName(row.label);
    if (!allowFallbackOnly && !primaryLabels.has(label)) return;
    const current = byLabel.get(label) || { label };
    byLabel.set(label, {
      ...current,
      ...Object.fromEntries(Object.entries(row).filter(([, value]) => {
        if (typeof value === 'number') return Number.isFinite(value) && value > 0;
        return cleanText(value);
      })),
      label,
    });
  });
  return uniqueByLabel([...byLabel.values()]);
}

function oneTimeRowsFromPricing(pricingBundle = {}) {
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
      return {
        service: cleanText(item.service || item.key) || null,
        label: cleanText(item.label || item.name || item.service || 'One-time service'),
        detail: detailParts.join(' - '),
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        oneTime: true,
      };
    });
}

function oneTimeRowsFromEstimateData(estData = {}) {
  const result = estData.result || estData.engineResult || estData || {};
  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  const items = [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
    ...(Array.isArray(nestedOneTime.items) ? nestedOneTime.items : []),
    ...(Array.isArray(nestedOneTime.specItems) ? nestedOneTime.specItems : []),
    ...(Array.isArray(result.specItems) ? result.specItems : []),
  ];
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
        service: cleanText(item.service || item.key) || null,
        label: cleanText(item.label || item.displayName || item.name || item.service || 'One-time service'),
        detail: detailParts.join(' - '),
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        oneTime: true,
      };
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

function buildEstimateAssistantContext({
  estimate = {},
  estData = {},
  pricingBundle = {},
  selectedFrequency = '',
  serviceMode = 'recurring',
} = {}) {
  const parsedData = parseEstimateData(estData);
  const requestedMode = serviceMode === 'one_time' ? 'one_time' : 'recurring';
  const frequency = selectPricingFrequency(pricingBundle, estimate, parsedData, selectedFrequency);
  const pricingRecurringRows = serviceRowsFromPricing(pricingBundle, frequency);
  const estimateRecurringRows = serviceRowsFromEstimateData(parsedData);
  const recurringServices = mergeServiceRows(
    pricingRecurringRows,
    estimateRecurringRows,
    { allowFallbackOnly: pricingRecurringRows.length === 0 },
  );
  const oneTimeServices = mergeServiceRows(
    oneTimeRowsFromPricing(pricingBundle),
    oneTimeRowsFromEstimateData(parsedData),
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
  // Expose separately-billed one-time add-ons that have their own Ask Waves chip
  // (German-roach cleanout, Bora-Care) even on a recurring estimate, so the
  // assistant context carries the row the chip's question is about.
  const hasAssistantVisibleOneTimeAddOn = oneTimeServices.some(
    (row) => isGermanRoachCleanoutContextRow(row) || isBoraCareContextRow(row),
  );
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
  const rowWithSummary = (row) => {
    const safeRow = quoteRequired
      ? {
          ...row,
          monthly: null,
          perApplication: null,
          amount: null,
          detail: cleanText(row.detail).replace(/\$[\d,]+(?:\.\d{1,2})?/g, 'price pending inspection'),
        }
      : row;
    return {
      ...safeRow,
      summary: serviceLine(safeRow),
    };
  };

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
    services: services.map(rowWithSummary),
    recurringServices: recurringServices.map(rowWithSummary),
    setupFee,
    firstVisitFees,
    oneTime: exposeOneTimeContext ? {
      amount: oneTimeContextAmount,
      amountText: oneTimeContextAmount ? fmtMoney(oneTimeContextAmount) : null,
      items: oneTimeServices.map(rowWithSummary),
    } : null,
    guarantees: {
      recurring: '90-day money-back guarantee on recurring WaveGuard service.',
      oneTime: 'One-time pest service may include a 30-day callback period when shown on the estimate.',
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
// vocabulary — "what if it rains after treatment?" is a label question, but
// "will you still come if it rains after 2pm?" is scheduling and must stay
// on the normal path.
// "water" alternates are irrigation-anchored: watering-context wording
// ("water the lawn", "how soon can I water") routes here, but "standing
// water" (mosquito breeding) and "keep mosquitoes off" (efficacy) are
// service questions and stay on the normal path. keep-off is restricted to
// people/pets — that's re-entry wording.
const FORCE_FALLBACK_QUESTION_PATTERN = /\b(safe|pet|dog|cat|kid|child|chemical|product|products|spray|label|applied|application|lawn|turf|weed|fungus|fertil|pest|roach(?:es)?|cockroach(?:es)?|ants?|spider|inside|interior|outside|exterior|irrigat\w*|sprinkl\w*|rain[-\s]?fast|rain[-\s]?proof|re-?ent(?:er|ry|ering)\w*|dry|dries|dried|drying)\b|\bkeep\s+(?:people|pets?|kids?|children|dogs?|cats?|everyone|family)\s+off\b|\bkeep\s+off\b|\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)(?=[^.?!]{0,40}\b(?:after|before|until|lawn|turf|grass|yard|plants?|treat\w*|appl\w*|spray\w*|dry|dries|dried)\b)|\b(?:after|before|until|once|when|how\s+soon|how\s+long)\b[^.?!]{0,40}\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)|\brains?\s+(?:right\s+)?after\s+(?:the\s+|my\s+|a\s+|an\s+|you\s+|we\s+)?(?:treat\w*|appl\w*|spray\w*|service|visit)\b|\b(?:treat|appl|spray)\w*\b[^.?!]{0,40}\bafter\s+(?:it\s+|the\s+)?rains?\b|\brain\s+wash\w*\b/i;

// Generic treatment vocabulary says nothing about WHICH product a question
// targets, so it never counts as naming one.
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

// True when the question names this SPECIFIC product: the product name (via
// the questionNameMatch flag the context builder stamps, so the name itself
// never rides along in the row) or an active ingredient. Title and snippet
// are deliberately excluded: every catalog row's title reads "<category>
// active ingredient", and snippet would let generic re-entry copy
// ("...sprays have dried") match.
function catalogRowNamesProduct(row = {}, question = '') {
  if (row.questionNameMatch === true) return true;
  const ingredientText = cleanText(row.activeIngredient || '').toLowerCase();
  if (!ingredientText) return false;
  if (questionTermsForMatching(question).some((term) => ingredientText.includes(term))) return true;
  // Short/punctuated active-ingredient names ("2,4-D", "Bti") never survive
  // the >=4-char term filter above — compare whole normalized question words
  // against normalized ingredient aliases by exact equality instead.
  // Ingredient lists separate aliases with +, /, ; or "and" — NOT comma,
  // which is part of names like 2,4-D.
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = cleanText(row.activeIngredient || '')
    .split(/[+/;]|\band\b/i)
    .map(normalize)
    .filter((alias) => alias.length >= 2);
  if (!aliases.length) return false;
  const questionWords = cleanText(question).split(/\s+/).map(normalize).filter(Boolean);
  return aliases.some((alias) => questionWords.includes(alias));
}

// True when the question names this row's broad CATEGORY ("the herbicide",
// "the insecticide") — weaker targeting than naming the product, so callers
// intersect these with any named families instead of trusting them alone.
function catalogRowMentionsCategory(row = {}, question = '') {
  const text = cleanText([row.category, row.path].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return false;
  return questionTermsForMatching(question).some((term) => text.includes(term));
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
  const namedRows = rows.filter((row) => catalogRowNamesProduct(row, question));
  const productMentions = namedRows.filter(onEstimate);
  // The customer named a product and NONE of the named rows are on this
  // estimate: fail closed outright. Category words in the same breath ("is
  // glyphosate HERBICIDE safe?") describe that product — they must not fall
  // through to the estimate's own products' facts.
  if (namedRows.length && !productMentions.length) return [];
  const categoryMentions = rows.filter((row) => catalogRowMentionsCategory(row, question) && onEstimate(row));
  if (namedRows.length || categoryMentions.length) {
    // Broad category mentions ("the lawn insecticide") can match every
    // on-estimate row of that category — when the question also names
    // families, they must stay inside them.
    const scopedCategory = questionFamilies.length
      ? categoryMentions.filter((row) => attributedTo(row, questionFamilies))
      : categoryMentions;
    // A COORDINATED question ("is Bifenthrin AND the lawn treatment safe?",
    // "the lawn treatment PLUS Bifenthrin") asks about both the named
    // product and the named family — union them. The conjunction must join
    // family/treatment wording on EITHER side: "safe for kids and pets" is
    // not a product+family coordination, and without one the family word is
    // adjectival ("the 2,4-D lawn spray") so the explicit product stays the
    // narrower, correct scope.
    const questionText = cleanText(question);
    const coordinatesOntoFamily = /\b(?:and|plus|&|along with|as well as)\s+(?:the\s+|my\s+|our\s+)?(?:lawn\w*|turf|grass|pest\w*|mosquito\w*|termite\w*|rodent\w*|trees?|shrubs?|roach\w*|cockroach\w*|ants?|spiders?|perimeter|treat\w*|spray\w*|service)\b/i.test(questionText)
      || /\b(?:lawn\w*|turf|grass|pest\w*|mosquito\w*|termite\w*|rodent\w*|trees?|shrubs?|roach\w*|cockroach\w*|ants?|spiders?|perimeter|treat\w*|spray\w*|service)\s+(?:and|plus|&|along with|as well as)\b/i.test(questionText);
    const coordinatedFamilyRows = (productMentions.length && questionFamilies.length && coordinatesOntoFamily)
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
  if (reentries.length === 1) parts.push(`Label re-entry guidance: ${reentries[0].replace(/\.$/, '')}.`);
  else if (reentries.length > 1) parts.push(`Label re-entry guidance by product: ${reentries.map((text) => text.replace(/\.$/, '')).join('; ')}.`);
  if (signalWords.length) parts.push(`Label signal word${signalWords.length > 1 ? 's' : ''}: ${signalWords.join(', ')}.`);
  // Multiple products: quote the longest (most conservative) window — but as
  // a blanket claim only when EVERY scoped product (verified or not, hence
  // scopedRows not scoped) states one AND the catalog slice wasn't truncated
  // at its row cap (a truncated slice can't prove completeness — an omitted
  // product may have no stated window). The label seed intentionally leaves
  // rainfast blank where the label doesn't state a window, unverified rows
  // carry no window at all, and one product's window must not become a
  // claim about the rest.
  const catalogTruncated = (context.supportContext || context.aiSupport || {}).productCatalogTruncated === true;
  if (rainfast.length === scopedRows.length && rainfast.length && !catalogTruncated) {
    parts.push(`Treated areas are rainfast in about ${Math.max(...rainfast)} minutes.`);
  } else if (rainfast.length) {
    parts.push(`Where a product label states a rainfast window, treated areas are rainfast in about ${Math.max(...rainfast)} minutes; not every product on this estimate has a stated window on file.`);
  }
  if (irrigation.length === 1) parts.push(`Label watering/irrigation guidance: ${irrigation[0].replace(/\.$/, '')}.`);
  else if (irrigation.length > 1) parts.push(`Label watering/irrigation guidance by product: ${irrigation.map((text) => text.replace(/\.$/, '')).join('; ')}.`);
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
  if (/\blawn|turf|grass|weed|fungus|fertil|chinch\b/.test(q)) {
    return 'For lawns, Waves starts from turf condition, weed pressure, fungus pressure, irrigation clues, and seasonal Southwest Florida restrictions before selecting the treatment.';
  }
  if (/\bmosquito|mosquitoes\b/.test(q)) {
    return 'For mosquitoes, the focus is shaded resting zones, breeding-pressure checks, and timing around weather so the barrier treatment has the best chance to hold.';
  }
  if (/\btermite|termites\b/.test(q)) {
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

function answerEstimateQuestionFallback(question, context = {}) {
  const q = cleanText(question).toLowerCase();
  const phone = context.company?.phone || COMPANY.phone;
  const tier = context.waveGuardTier || 'WaveGuard';
  const billingText = context.billing?.amountText;
  const services = listServices(context);
  const oneTimeText = context.oneTime?.amountText;

  // Bora-Care questions are answered first — above the include/coverage, safety,
  // and product branches — so phrasings like "does Bora-Care cover beetles?" or
  // "is Bora-Care safe?" reach the borate-specific answer instead of the generic
  // service list or label-direction copy. Gated on the estimate actually including
  // Bora-Care AND a qualified Bora-Care intent so a lawn-fungus / shrub-beetle
  // question on a mixed estimate still reaches the relevant service branch.
  if (estimateContextHasBoraCare(context) && isBoraCareIntent(q)) {
    return `Bora-Care is a borate treatment applied to bare wood — attic framing and surface areas like the foundation and block. It treats the wood for termites, wood-boring beetles, and wood-decay fungi. Your technician follows the product label directions; for specifics on your home, call or text Waves at ${phone}.`;
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
  // people/pet "keep off", treatment-anchored rain-after, re-entry/dry
  // wording. "water bugs"/"standing water"/"keep mosquitoes off" are
  // service questions and belong to the branches below.
  if (/\b(safe|pet|dog|cat|kid|child|chemical|product|products|spray|label|applied|application|irrigat\w*|sprinkl\w*|rain[-\s]?fast|rain[-\s]?proof|re-?ent(?:er|ry|ering)\w*|dry|dries|dried|drying)\b|\bkeep\s+(?:people|pets?|kids?|children|dogs?|cats?|everyone|family)\s+off\b|\bkeep\s+off\b|\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)(?=[^.?!]{0,40}\b(?:after|before|until|lawn|turf|grass|yard|plants?|treat\w*|appl\w*|spray\w*|dry|dries|dried)\b)|\b(?:after|before|until|once|when|how\s+soon|how\s+long)\b[^.?!]{0,40}\b(?<!standing\s)(?<!breeding\s)water(?:ing|ed|s)?\b(?!\s+bugs?\b)|\brains?\s+(?:right\s+)?after\s+(?:the\s+|my\s+|a\s+|an\s+|you\s+|we\s+)?(?:treat\w*|appl\w*|spray\w*|service|visit)\b|\b(?:treat|appl|spray)\w*\b[^.?!]{0,40}\bafter\s+(?:it\s+|the\s+)?rains?\b|\brain\s+wash\w*\b/.test(q)) {
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
    if (context.serviceMode === 'one_time') {
      return `This is a one-time service, not a recurring WaveGuard membership. ${context.guarantees?.oneTime || 'One-time pest service may include a 30-day callback period when shown on the estimate.'}`;
    }
    return `${tier} is the WaveGuard membership level shown on this estimate. Recurring WaveGuard service includes the 90-day money-back guarantee shown here, member pricing, and ongoing service support from Waves.`;
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
    system: SYSTEM_PROMPT,
    text: buildAssistantUserContent(question, context),
    jsonMode: false,
    maxTokens: 420,
  });
  if (!r.ok || !r.text) return null;
  return cleanAssistantAnswer(r.text) || null;
}

async function answerWithAnthropic(question, context) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.ESTIMATE_ASSISTANT_MODEL || MODELS.WORKHORSE,
    max_tokens: 420,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildAssistantUserContent(question, context),
    }],
  });
  return extractAnthropicText(response);
}

async function answerEstimateQuestion({
  question,
  estimate,
  estData,
  pricingBundle,
  selectedFrequency,
  serviceMode,
  database = db,
} = {}) {
  const cleanQuestion = cleanText(question);
  const context = buildEstimateAssistantContext({
    estimate,
    estData,
    pricingBundle,
    selectedFrequency,
    serviceMode,
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

  if (FORCE_FALLBACK_QUESTION_PATTERN.test(cleanQuestion) && supportRows(context).length) {
    return {
      answer: answerEstimateQuestionFallback(cleanQuestion, context),
      source: 'fallback',
    };
  }

  // Live model — GPT-5.5. On any miss, fall back to Claude (WORKHORSE), then the
  // deterministic template — the customer always gets an answer.
  try {
    const openAiAnswer = await answerWithOpenAI(cleanQuestion, context);
    if (openAiAnswer) return { answer: openAiAnswer, source: 'openai' };
  } catch (err) {
    logger.warn(`[estimate-assistant] OpenAI answer failed: ${err.message}`);
  }

  try {
    const aiAnswer = await answerWithAnthropic(cleanQuestion, context);
    if (aiAnswer) return { answer: aiAnswer, source: 'anthropic' };
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
