const logger = require('./logger');
const MODELS = require('../config/models');
const db = require('../models/db');
const { WAVEGUARD } = require('./pricing-engine/constants');
const { loadEstimateAiSupportContext } = require('./estimate-ai-context');

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
    if (key === 'standard' || key === 'enhanced') return key;
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
    oneTime: !quoteRequired && oneTimeAvailable && Number.isFinite(oneTimeTotal) && oneTimeTotal > 0 ? {
      amount: oneTimeTotal,
      amountText: fmtMoney(oneTimeTotal),
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
  const rows = Array.isArray(context.services) ? context.services : [];
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

function activeIngredientsFromSupport(context = {}, question = '') {
  const ingredients = [];
  for (const row of supportRows(context)) {
    if (row.source === 'admin_product_catalog' && row.activeIngredient) ingredients.push(row.activeIngredient);
  }
  return [...new Set(ingredients.map(cleanText).filter(Boolean))].slice(0, 8);
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

function treatmentApproachForQuestion(question = '') {
  const q = cleanText(question).toLowerCase();
  if (/\bant|ants\b/.test(q)) {
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
  return (Array.isArray(context.services) ? context.services : [])
    .find((row) => pattern.test(`${row.label} ${row.detail} ${row.summary}`));
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

function answerEstimateQuestionFallback(question, context = {}) {
  const q = cleanText(question).toLowerCase();
  const phone = context.company?.phone || COMPANY.phone;
  const tier = context.waveGuardTier || 'WaveGuard';
  const billingText = context.billing?.amountText;
  const services = listServices(context);
  const oneTimeText = context.oneTime?.amountText;

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

  if (/\b(safe|pet|dog|cat|kid|child|chemical|product|products|spray|label|applied|application)\b/.test(q)) {
    const activeIngredients = activeIngredientsFromSupport(context, question);
    const labelCopy = 'Your technician will follow the product label directions for every application.';
    if (activeIngredients.length) {
      return [
        `${treatmentApproachForQuestion(question)} Active ingredients/classes in the admin catalog for this service type include ${activeIngredients.join(', ')}.`,
        `${labelCopy} If you have pets, kids, sensitivities, or want the exact product for your home that day, call or text Waves at ${phone}.`,
      ].filter(Boolean).join(' ');
    }
    return `${treatmentApproachForQuestion(question)} ${labelCopy} If you have pets, kids, sensitivities, or a specific product question, call or text Waves at ${phone} so the team can give instructions for your home.`;
  }

  if (/\b(lawn|turf|weed|fungus|grass|fertil)\b/.test(q)) {
    const lawn = findService(context, /lawn|turf|weed|fungus|grass|fertil/i);
    const activeIngredients = activeIngredientsFromSupport(context, question);
    return lawn
      ? [
          `For lawn care, this estimate shows ${lawn.summary}.`,
          treatmentApproachForQuestion(question),
          activeIngredients.length ? `Relevant active ingredients/classes in the admin catalog include ${activeIngredients.join(', ')}.` : '',
        ].filter(Boolean).join(' ')
      : `I do not see lawn care on this estimate. Call or text Waves at ${phone} if you want it added.`;
  }

  if (/\b(pest|bug|roach|ants?|spider|inside|interior|outside|exterior)\b/.test(q)) {
    const pest = findService(context, /pest|roach|ant|spider|perimeter/i);
    const activeIngredients = activeIngredientsFromSupport(context, question);
    return pest
      ? [
          `For pest control, this estimate shows ${pest.summary}.`,
          treatmentApproachForQuestion(question),
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

async function answerWithAnthropic(question, context) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.ESTIMATE_ASSISTANT_MODEL || MODELS.WORKHORSE,
    max_tokens: 420,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Customer question:\n${question}\n\nEstimate context JSON:\n${JSON.stringify(context, null, 2)}`,
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

  if (/\b(safe|pet|dog|cat|kid|child|chemical|product|products|spray|label|applied|application|lawn|turf|weed|fungus|fertil|pest|roach|ants?|spider|inside|interior|outside|exterior)\b/i.test(cleanQuestion)
      && supportRows(context).length) {
    return {
      answer: answerEstimateQuestionFallback(cleanQuestion, context),
      source: 'fallback',
    };
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
};
